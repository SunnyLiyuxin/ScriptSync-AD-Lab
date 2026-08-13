/**
 * Yjs 数据操作层
 * 封装对 events 数组的 CRUD，含：
 * - 按时间有序插入
 * - 文本编辑（Yjs 自动处理并发冲突）
 * - 时间调整（含重叠检测，等价于 ScriptGrid 的打轴合法性校验）
 * - 段落锁（awareness 协同）
 * - 状态机流转
 * 复用 ScriptSync 操作模型，增强为带状态机的版本
 */
import * as Y from 'yjs';
import { nanoid } from 'nanoid';
import type { AssEvent, EventStatus, ReviewComment } from '../../types/ass';

type YEvent = Y.Map<unknown>;

/**
 * 创建字幕条目（按时间有序插入）
 */
export function createEvent(
  doc: Y.Doc,
  data: Partial<AssEvent>,
): string {
  const events = doc.getArray<YEvent>('events');
  const id = data.id || nanoid();
  const start = data.start ?? 0;

  const yMap = new Y.Map();
  yMap.set('id', id);
  yMap.set('layer', data.layer ?? 1);
  yMap.set('start', start);
  yMap.set('end', data.end ?? start);
  yMap.set('style', data.style || 'Narration');
  yMap.set('name', data.name || '');
  yMap.set('text', data.text || '');
  yMap.set('_status', data._status || 'draft');
  yMap.set('_lockedBy', null);
  yMap.set('_assignedTo', data._assignedTo ?? null);
  yMap.set('_owner', data._owner ?? null);
  yMap.set('_needsRevisionBy', null);
  yMap.set('_needsRevisionByName', null);

  // 按时间插入到正确位置（保持有序，便于渲染与重叠检测）
  let idx = events.length;
  for (let i = 0; i < events.length; i++) {
    if ((events.get(i) as YEvent).get('start') as number > start) {
      idx = i;
      break;
    }
  }
  events.insert(idx, [yMap]);
  return id;
}

/**
 * 在指定索引处插入字幕条目（用于「插入上一行/下一行」右键菜单）
 * 与 createEvent 不同：不按时间排序，而是精确插入到指定数组位置
 * @param index 插入位置（0=最前，length=最后）
 * @returns 新条目 id
 */
export function insertEventAt(
  doc: Y.Doc,
  index: number,
  data: Partial<AssEvent>,
): string {
  const events = doc.getArray<YEvent>('events');
  const id = data.id || nanoid();
  const start = data.start ?? 0;

  const yMap = new Y.Map();
  yMap.set('id', id);
  yMap.set('layer', data.layer ?? 1);
  yMap.set('start', start);
  yMap.set('end', data.end ?? start);
  yMap.set('style', data.style || 'Narration');
  yMap.set('name', data.name || '');
  yMap.set('text', data.text || '');
  yMap.set('_status', data._status || 'draft');
  yMap.set('_lockedBy', null);
  yMap.set('_assignedTo', data._assignedTo ?? null);
  yMap.set('_owner', data._owner ?? null);
  yMap.set('_needsRevisionBy', null);
  yMap.set('_needsRevisionByName', null);

  const clampedIndex = Math.max(0, Math.min(index, events.length));
  events.insert(clampedIndex, [yMap]);
  return id;
}

/**
 * 按 ID 查找事件在 Yjs events 数组中的索引（用于精确插入位置）
 * 注意：与 exportEvents 排序后的数组不同，此处返回的是原始 Yjs 数组索引
 * @returns 索引，未找到返回 -1
 */
export function findEventIndex(doc: Y.Doc, eventId: string): number {
  const events = doc.getArray<YEvent>('events');
  for (let i = 0; i < events.length; i++) {
    if ((events.get(i).get('id') as string) === eventId) return i;
  }
  return -1;
}

/**
 * 按 ID 查找事件
 */
function findEvent(doc: Y.Doc, eventId: string): YEvent | null {
  const events = doc.getArray<YEvent>('events');
  for (let i = 0; i < events.length; i++) {
    const e = events.get(i);
    if ((e.get('id') as string) === eventId) return e;
  }
  return null;
}

/**
 * 权限校验：只有 _assignedTo === currentUserId 才能编辑
 * 这是"防误删/误修改他人部分"机制的核心——数据层校验，不依赖 UI 隐藏
 * 即使前端 UI 被绕过（如控制台直接调用），数据层也拒绝写入
 *
 * 注：阶段3 接入角色矩阵后，owner/manager/reviewer 可编辑他人行。
 * 此处保留原"仅负责人可编辑"作为数据层底线；角色放权在前端 hasPermission 判定。
 * 数据层接受一个可选 role 参数，若 role 具备 edit_others_rows 则放行他人行。
 */
function canEdit(e: YEvent, currentUserId: string, role?: string): boolean {
  const assignedTo = e.get('_assignedTo') as string | null;
  // 角色放权：owner/manager/reviewer 可编辑他人行
  if (role === 'owner' || role === 'manager' || role === 'reviewer') return true;
  // 已分配：只有负责人可编辑
  if (assignedTo !== null) return assignedTo === currentUserId;
  // 未分配：暂不允许普通编辑（等负责人分配后才能编辑）
  return false;
}

/**
 * 编辑字幕文本（Yjs CRDT 自动合并并发编辑）
 * @param currentUserId 当前用户ID，用于权限校验
 * @param role 当前用户角色（可选，阶段3 角色放权）
 */
export function updateText(doc: Y.Doc, eventId: string, text: string, currentUserId: string, role?: string): boolean {
  const e = findEvent(doc, eventId);
  if (!e) return false;
  if (!canEdit(e, currentUserId, role)) return false; // 权限校验
  e.set('text', text);
  return true;
}

/**
 * 调整时间（含重叠检测 + 权限校验）
 * 等价于 ScriptGrid generate_narration_timing 的时间轴合法性校验，变为实时约束
 * @returns true=成功, false=冲突或无权限
 */
export function updateTime(
  doc: Y.Doc,
  eventId: string,
  start: number,
  end: number,
  currentUserId: string,
  role?: string,
): boolean {
  if (end < start) return false; // 自身非法

  const target = findEvent(doc, eventId);
  if (!target) return false;
  if (!canEdit(target, currentUserId, role)) return false; // 权限校验

  const events = doc.getArray<YEvent>('events');
  // 重叠检测：与同 layer 的其他条目不能时间交叉
  for (let i = 0; i < events.length; i++) {
    const e = events.get(i);
    if ((e.get('id') as string) === eventId) continue;
    if ((e.get('_status') as EventStatus) === 'deleted') continue;
    if ((e.get('layer') as number) !== (target.get('layer') as number)) continue;

    const eStart = e.get('start') as number;
    const eEnd = e.get('end') as number;
    if (start < eEnd && end > eStart) return false; // 冲突
  }

  target.set('start', start);
  target.set('end', end);
  return true;
}

/**
 * 软删除（协作中可恢复）+ 权限校验
 */
export function softDeleteEvent(doc: Y.Doc, eventId: string, currentUserId: string, role?: string): boolean {
  const e = findEvent(doc, eventId);
  if (!e) return false;
  if (!canEdit(e, currentUserId, role)) return false; // 权限校验
  e.set('_status', 'deleted');
  e.set('_needsRevisionBy', null);
  e.set('_needsRevisionByName', null);
  return true;
}

/**
 * 批量硬删除（从 Yjs 数组中彻底移除，用于清理导入的 ASS 字幕）
 * 与 softDeleteEvent 不同：直接从 events 数组删除
 * 单事务执行，避免多次广播
 * @returns 实际删除的条目数
 */
export function deleteEventsBulk(doc: Y.Doc, eventIds: string[]): number {
  const events = doc.getArray<YEvent>('events');
  let count = 0;
  doc.transact(() => {
    // 收集要删除的索引（从大到小，避免删除时索引错位）
    const indices: number[] = [];
    for (let i = 0; i < events.length; i++) {
      const id = events.get(i).get('id') as string;
      if (eventIds.includes(id)) indices.push(i);
    }
    for (let j = indices.length - 1; j >= 0; j--) {
      events.delete(indices[j], 1);
      count++;
    }
  });
  return count;
}

/**
 * 收集待删除事件的快照（含原始索引 + 完整数据），供撤销恢复使用
 */
export interface DeletedEventSnapshot {
  index: number;
  data: Partial<AssEvent>;
}

export function collectDeletedSnapshots(doc: Y.Doc, eventIds: string[]): DeletedEventSnapshot[] {
  const events = doc.getArray<YEvent>('events');
  const snapshots: DeletedEventSnapshot[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events.get(i);
    const id = e.get('id') as string;
    if (eventIds.includes(id)) {
      snapshots.push({
        index: i,
        data: {
          id,
          layer: e.get('layer') as number,
          start: e.get('start') as number,
          end: e.get('end') as number,
          style: e.get('style') as string,
          name: (e.get('name') as string) || '',
          text: e.get('text') as string,
          _status: e.get('_status') as EventStatus,
          _assignedTo: (e.get('_assignedTo') as string | null) ?? null,
          _owner: (e.get('_owner') as string | null) ?? null,
          _needsRevisionBy: (e.get('_needsRevisionBy') as string | null) ?? null,
          _needsRevisionByName: (e.get('_needsRevisionByName') as string | null) ?? null,
        },
      });
    }
  }
  return snapshots;
}

/**
 * 恢复已删除的事件（按原始索引升序逐条插入，保证位置正确）
 */
export function restoreEvents(doc: Y.Doc, snapshots: DeletedEventSnapshot[]): number {
  const events = doc.getArray<YEvent>('events');
  let count = 0;
  // 按索引升序排序后逐条插入：每次插入只会影响后续索引，不影响前面
  const sorted = [...snapshots].sort((a, b) => a.index - b.index);
  doc.transact(() => {
    for (const snap of sorted) {
      const yMap = new Y.Map();
      yMap.set('id', snap.data.id || nanoid());
      yMap.set('layer', snap.data.layer ?? 1);
      yMap.set('start', snap.data.start ?? 0);
      yMap.set('end', snap.data.end ?? snap.data.start ?? 0);
      yMap.set('style', snap.data.style || 'Narration');
      yMap.set('name', snap.data.name || '');
      yMap.set('text', snap.data.text || '');
      yMap.set('_status', snap.data._status || 'draft');
      yMap.set('_lockedBy', null);
      yMap.set('_assignedTo', snap.data._assignedTo ?? null);
      yMap.set('_owner', snap.data._owner ?? null);
      yMap.set('_needsRevisionBy', snap.data._needsRevisionBy ?? null);
      yMap.set('_needsRevisionByName', snap.data._needsRevisionByName ?? null);
      const idx = Math.max(0, Math.min(snap.index, events.length));
      events.insert(idx, [yMap]);
      count++;
    }
  });
  return count;
}

/**
 * 设置条目状态（权限驱动 + needs_revision 头像标记）
 * - owner：可设置 needs_revision / in_review / approved / locked / deleted
 * - 普通成员（含段落负责人）：仅可设置 needs_revision，并记录其 userId/username 用于头像显示
 * - owner 操作不显示头像；状态离开 needs_revision 时清除头像标记
 * @returns true=成功, false=无权限或条目不存在
 */
export function setStatus(
  doc: Y.Doc,
  eventId: string,
  newStatus: EventStatus,
  currentUser: { userId: string; username: string },
  isOwner: boolean,
): boolean {
  const e = findEvent(doc, eventId);
  if (!e) return false;
  const ownerAllowed: EventStatus[] = ['needs_revision', 'in_review', 'approved', 'locked', 'deleted'];
  if (isOwner) {
    if (!ownerAllowed.includes(newStatus)) return false;
  } else {
    if (newStatus !== 'needs_revision') return false;
  }
  e.set('_status', newStatus);
  if (newStatus === 'needs_revision' && !isOwner) {
    // 普通成员标记需修改 → 记录头像
    e.set('_needsRevisionBy', currentUser.userId);
    e.set('_needsRevisionByName', currentUser.username);
  } else {
    // owner 设置 needs_revision 不留头像；任何非 needs_revision 状态清除头像
    e.set('_needsRevisionBy', null);
    e.set('_needsRevisionByName', null);
  }
  return true;
}

/**
 * 分配条目给口述员
 * 注：调用方需在前端先校验 assign_work 权限（owner/manager）；
 *     数据层不强制，因为 owner 转让或紧急情况下需要灵活指派。
 */
export function assignEvent(
  doc: Y.Doc,
  eventId: string,
  userId: string | null,
): boolean {
  const e = findEvent(doc, eventId);
  if (!e) return false;
  e.set('_assignedTo', userId);
  return true;
}

/**
 * 批量分配多条目给同一口述员（阶段4 工作分配）
 * 单事务执行，避免多次广播 update。
 */
export function assignEventsBulk(
  doc: Y.Doc,
  eventIds: string[],
  userId: string | null,
): number {
  let count = 0;
  doc.transact(() => {
    for (const id of eventIds) {
      const e = findEvent(doc, id);
      if (e) {
        e.set('_assignedTo', userId);
        count++;
      }
    }
  });
  return count;
}

/**
 * 添加审阅批注
 */
export function addComment(
  doc: Y.Doc,
  eventId: string,
  comment: Omit<ReviewComment, 'id' | 'createdAt' | 'resolved'>,
): string {
  const commentsMap = doc.getMap<Y.Array<Y.Map<unknown>>>('comments');
  let arr = commentsMap.get(eventId);
  if (!arr) {
    arr = new Y.Array();
    commentsMap.set(eventId, arr);
  }
  const id = nanoid();
  const commentMap = new Y.Map();
  commentMap.set('id', id);
  commentMap.set('authorId', comment.authorId);
  commentMap.set('authorName', comment.authorName);
  commentMap.set('content', comment.content);
  commentMap.set('createdAt', Date.now());
  commentMap.set('resolved', false);
  commentMap.set('position', comment.position ?? null);
  arr.push([commentMap]);
  return id;
}

/**
 * 获取指定事件的所有批注（含嵌套回复）
 */
export function getComments(doc: Y.Doc, eventId: string): ReviewComment[] {
  const commentsMap = doc.getMap<Y.Array<Y.Map<unknown>>>('comments');
  const arr = commentsMap.get(eventId);
  if (!arr) return [];
  const result: ReviewComment[] = [];
  for (let i = 0; i < arr.length; i++) {
    result.push(readCommentMap(arr.get(i)));
  }
  return result;
}

/** 从 Y.Map 读取一条批注（含 replies） */
function readCommentMap(m: Y.Map<unknown>): ReviewComment {
  const pos = m.get('position');
  const comment: ReviewComment = {
    id: m.get('id') as string,
    authorId: m.get('authorId') as string,
    authorName: m.get('authorName') as string,
    content: m.get('content') as string,
    createdAt: m.get('createdAt') as number,
    resolved: m.get('resolved') as boolean,
    position: typeof pos === 'number' ? pos : undefined,
  };
  const repliesArr = m.get('replies') as Y.Array<Y.Map<unknown>> | undefined;
  if (repliesArr && repliesArr.length > 0) {
    comment.replies = [];
    for (let j = 0; j < repliesArr.length; j++) {
      comment.replies.push(readCommentMap(repliesArr.get(j)));
    }
  }
  return comment;
}

/**
 * 标记批注为已解决（支持顶层批注与嵌套回复）
 */
export function resolveComment(doc: Y.Doc, eventId: string, commentId: string): boolean {
  const commentsMap = doc.getMap<Y.Array<Y.Map<unknown>>>('comments');
  const arr = commentsMap.get(eventId);
  if (!arr) return false;
  for (let i = 0; i < arr.length; i++) {
    const c = arr.get(i);
    if ((c.get('id') as string) === commentId) {
      c.set('resolved', true);
      return true;
    }
    const repliesArr = c.get('replies') as Y.Array<Y.Map<unknown>> | undefined;
    if (repliesArr) {
      for (let j = 0; j < repliesArr.length; j++) {
        if ((repliesArr.get(j).get('id') as string) === commentId) {
          repliesArr.get(j).set('resolved', true);
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * 删除批注（含嵌套回复；删除顶层批注会一并删除其回复）
 */
export function deleteComment(doc: Y.Doc, eventId: string, commentId: string): boolean {
  const commentsMap = doc.getMap<Y.Array<Y.Map<unknown>>>('comments');
  const arr = commentsMap.get(eventId);
  if (!arr) return false;
  for (let i = 0; i < arr.length; i++) {
    const c = arr.get(i);
    if ((c.get('id') as string) === commentId) {
      arr.delete(i, 1);
      return true;
    }
    const repliesArr = c.get('replies') as Y.Array<Y.Map<unknown>> | undefined;
    if (repliesArr) {
      for (let j = 0; j < repliesArr.length; j++) {
        if ((repliesArr.get(j).get('id') as string) === commentId) {
          repliesArr.delete(j, 1);
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * 添加批注回复（嵌套在父批注的 replies Y.Array 下）
 * @returns 新回复的 id，父批注不存在时返回 null
 */
export function addReply(
  doc: Y.Doc,
  eventId: string,
  parentId: string,
  reply: Omit<ReviewComment, 'id' | 'createdAt' | 'resolved'>,
): string | null {
  const commentsMap = doc.getMap<Y.Array<Y.Map<unknown>>>('comments');
  const arr = commentsMap.get(eventId);
  if (!arr) return null;
  for (let i = 0; i < arr.length; i++) {
    const c = arr.get(i);
    if ((c.get('id') as string) === parentId) {
      let repliesArr = c.get('replies') as Y.Array<Y.Map<unknown>> | undefined;
      if (!repliesArr) {
        repliesArr = new Y.Array();
        c.set('replies', repliesArr);
      }
      const id = nanoid();
      const replyMap = new Y.Map();
      replyMap.set('id', id);
      replyMap.set('authorId', reply.authorId);
      replyMap.set('authorName', reply.authorName);
      replyMap.set('content', reply.content);
      replyMap.set('createdAt', Date.now());
      replyMap.set('resolved', false);
      replyMap.set('position', reply.position ?? null);
      repliesArr.push([replyMap]);
      return id;
    }
  }
  return null;
}

/**
 * 导入 AssEvent 数组到 Yjs 文档（批量初始化，如解析 ASS 文件后）
 * 注意：此函数会清空现有 events，仅用于首次导入。
 * 多人分段导入请使用 importEventsMerge。
 */
export function importEvents(doc: Y.Doc, events: AssEvent[]): void {
  const yEvents = doc.getArray<YEvent>('events');
  doc.transact(() => {
    // 清空现有
    yEvents.delete(0, yEvents.length);
    // 按时间排序后批量插入
    const sorted = [...events].sort((a, b) => a.start - b.start);
    const yMaps = sorted.map(e => {
      const m = new Y.Map();
      m.set('id', e.id);
      m.set('layer', e.layer);
      m.set('start', e.start);
      m.set('end', e.end);
      m.set('style', e.style);
      m.set('name', e.name);
      m.set('text', e.text);
      m.set('_status', e._status);
      m.set('_lockedBy', null);
      m.set('_assignedTo', e._assignedTo ?? null);
      m.set('_owner', e._owner ?? null);
      m.set('_needsRevisionBy', null);
      m.set('_needsRevisionByName', null);
      return m;
    });
    yEvents.push(yMaps);
  });
}

/**
 * 合并导入：将新条目按时间偏移映射后，合并插入到现有 events（不清空）。
 * - 时间偏移：parsed 条目的 start/end 加上 timeOffset（用户输入的开始秒数）
 * - 合并排序：按 start 升序插入到正确位置，保证整个表格时间连续
 * - 冲突检测：与同 layer 已有条目时间重叠的条目 id 返回，由前端标红
 * @returns 与已有条目时间重叠的新导入条目 id 列表（用于冲突标红）
 */
export function importEventsMerge(
  doc: Y.Doc,
  newEvents: AssEvent[],
  timeOffset: number = 0,
): string[] {
  const yEvents = doc.getArray<YEvent>('events');
  const conflictIds: string[] = [];

  doc.transact(() => {
    // 偏移映射 + 排序
    const offsetted = newEvents
      .map(e => ({
        ...e,
        start: e.start + timeOffset,
        end: e.end + timeOffset,
      }))
      .sort((a, b) => a.start - b.start);

    // 逐条按时间有序插入
    for (const e of offsetted) {
      // 冲突检测：与同 layer 非删除条目时间重叠
      let hasConflict = false;
      for (let i = 0; i < yEvents.length; i++) {
        const existing = yEvents.get(i);
        if ((existing.get('_status') as EventStatus) === 'deleted') continue;
        if ((existing.get('layer') as number) !== e.layer) continue;
        const eStart = existing.get('start') as number;
        const eEnd = existing.get('end') as number;
        if (e.start < eEnd && e.end > eStart) {
          hasConflict = true;
          break;
        }
      }
      if (hasConflict) conflictIds.push(e.id);

      const m = new Y.Map();
      m.set('id', e.id);
      m.set('layer', e.layer);
      m.set('start', e.start);
      m.set('end', e.end);
      m.set('style', e.style);
      m.set('name', e.name);
      m.set('text', e.text);
      m.set('_status', e._status);
      m.set('_lockedBy', null);
      m.set('_assignedTo', e._assignedTo ?? null);
      m.set('_owner', e._owner ?? null);
      m.set('_needsRevisionBy', null);
      m.set('_needsRevisionByName', null);

      // 找到第一个 start 大于当前条目 start 的位置插入
      let idx = yEvents.length;
      for (let i = 0; i < yEvents.length; i++) {
        if ((yEvents.get(i).get('start') as number) > e.start) {
          idx = i;
          break;
        }
      }
      yEvents.insert(idx, [m]);
    }
  });

  return conflictIds;
}

/**
 * 从 Yjs 文档导出为 AssEvent 数组（用于导出 ASS/SRT/Excel）
 */
export function exportEvents(doc: Y.Doc): AssEvent[] {
  const yEvents = doc.getArray<YEvent>('events');
  const result: AssEvent[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < yEvents.length; i++) {
    const e = yEvents.get(i);
    if ((e.get('_status') as EventStatus) === 'deleted') continue;
    const id = e.get('id') as string;
    // 防止重复 ID 导致 Svelte keyed-each 崩溃（IndexedDB 残留或并发插入可能产生重复）
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    result.push({
      id,
      layer: e.get('layer') as number,
      start: e.get('start') as number,
      end: e.get('end') as number,
      style: e.get('style') as string,
      name: (e.get('name') as string) || '',
      text: e.get('text') as string,
      _status: e.get('_status') as EventStatus,
      _lockedBy: (e.get('_lockedBy') as string | null) ?? null,
      _assignedTo: (e.get('_assignedTo') as string | null) ?? null,
      _owner: (e.get('_owner') as string | null) ?? null,
      _needsRevisionBy: (e.get('_needsRevisionBy') as string | null) ?? null,
      _needsRevisionByName: (e.get('_needsRevisionByName') as string | null) ?? null,
    });
  }
  return result.sort((a, b) => a.start - b.start);
}

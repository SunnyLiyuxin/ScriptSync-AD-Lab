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
  yMap.set('_status', data._status || 'empty');
  yMap.set('_lockedBy', null);
  yMap.set('_assignedTo', data._assignedTo ?? null);

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
  // empty 状态写入文字后自动转 draft
  if ((e.get('_status') as EventStatus) === 'empty') {
    e.set('_status', 'draft');
  }
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
  return true;
}

/**
 * 状态机流转
 * empty → draft → peer_review → approved → locked
 *                 ↘ revision_needed → draft
 */
const VALID_TRANSITIONS: Record<EventStatus, EventStatus[]> = {
  empty: ['draft'],
  draft: ['peer_review', 'deleted'],
  peer_review: ['approved', 'revision_needed'],
  revision_needed: ['draft'],
  approved: ['locked', 'revision_needed'],
  locked: ['approved'], // 解锁回 approved
  deleted: ['draft'], // 恢复
};

export function transitionStatus(
  doc: Y.Doc,
  eventId: string,
  newStatus: EventStatus,
  currentUserId: string,
  role?: string,
): boolean {
  const e = findEvent(doc, eventId);
  if (!e) return false;
  if (!canEdit(e, currentUserId, role)) return false; // 权限校验
  const cur = e.get('_status') as EventStatus;
  const allowed = VALID_TRANSITIONS[cur];
  if (!allowed || !allowed.includes(newStatus)) return false;
  e.set('_status', newStatus);
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
      return m;
    });
    yEvents.push(yMaps);
  });
}

/**
 * 从 Yjs 文档导出为 AssEvent 数组（用于导出 ASS/SRT/Excel）
 */
export function exportEvents(doc: Y.Doc): AssEvent[] {
  const yEvents = doc.getArray<YEvent>('events');
  const result: AssEvent[] = [];
  for (let i = 0; i < yEvents.length; i++) {
    const e = yEvents.get(i);
    if ((e.get('_status') as EventStatus) === 'deleted') continue;
    result.push({
      id: e.get('id') as string,
      layer: e.get('layer') as number,
      start: e.get('start') as number,
      end: e.get('end') as number,
      style: e.get('style') as string,
      name: (e.get('name') as string) || '',
      text: e.get('text') as string,
      _status: e.get('_status') as EventStatus,
      _lockedBy: (e.get('_lockedBy') as string | null) ?? null,
      _assignedTo: (e.get('_assignedTo') as string | null) ?? null,
    });
  }
  return result.sort((a, b) => a.start - b.start);
}

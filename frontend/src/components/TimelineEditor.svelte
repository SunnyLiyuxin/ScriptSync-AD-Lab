<script lang="ts">
  /**
   * 时间轴编辑器 - 核心组件（表格行式，类 Aegisub）
   * 整合波形、视频、字幕表格、协作
   *
   * 关键设计：
   * 1. 表格化编辑（替代卡片）：键盘上下键切换行，双击/Enter编辑
   * 2. 视图过滤：「所有」看全部 / 「只看自己」只看自己负责的
   * 3. 权限保护：只能编辑 _assignedTo === userId 的行，他人行只读
   * 4. 实时保存开关：开启时输入即保存；关闭时手动统一保存自己负责的部分
   * 5. 点击行 → 视频跳转到该条开始时间
   * 6. 视频上传入口（流式，支持大文件）
   */
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import * as Y from 'yjs';
  import type { WebsocketProvider } from 'y-websocket';
  import VideoPlayer from './VideoPlayer.svelte';
  import WaveformDisplay from './WaveformDisplay.svelte';
  import ExportPanel from './ExportPanel.svelte';
  import ReviewPanel from './ReviewPanel.svelte';
  import VersionHistory from './VersionHistory.svelte';
  import AiReviewPanel from './AiReviewPanel.svelte';
  import ContinuityCheck from './ContinuityCheck.svelte';
  import RehearsalMode from './RehearsalMode.svelte';
  import { type WaveformData } from '../lib/audio/audio-analyzer';
  import { detectSilence, markOccupiedRegions, type SilenceRegion } from '../lib/audio/silence-detector';
  import { findNextBlank, findPrevBlank } from '../lib/audio/jump-blank';
  import { exportEvents, createEvent, updateText, updateTime, transitionStatus, importEvents, assignEvent, assignEventsBulk, softDeleteEvent, addComment, getComments } from '../lib/collaboration/yjs-operations';
  import { lockEntry, unlockEntry, getLockHolder, getOnlineUsers, getOtherCursors } from '../lib/collaboration/awareness-lock';
  import { createShortcutManager, createDefaultShortcuts } from '../lib/shortcuts/shortcut-manager';
  import { recordEdit, getEditHistory } from '../lib/collaboration/edit-history';
  import type { EditHistoryEntryWithEvent } from '../lib/collaboration/edit-history';
  import { parseAss } from '../lib/ass/parser';
  import { parseInlineTags, stripAllTags } from '../lib/ass/tag-parser';
  import { formatDisplayTime } from '../lib/ass/time-utils';
  import type { AssEvent, EventStatus, ReviewComment } from '../types/ass';
  import type { MemberRole, ProjectMember, Permission } from '../types/project';
  import { hasPermission, ROLE_LABELS } from '../types/project';

  interface Props {
    doc: Y.Doc;
    provider: WebsocketProvider;
    userId: string;
    username: string;
    videoSrc: string;
    projectId: string;
    authToken: string;
    myRole?: MemberRole | null;
    members?: ProjectMember[];
  }

  let { doc, provider, userId, username, videoSrc, projectId, authToken, myRole = null, members = [] }: Props = $props();

  // 响应式状态
  let events = $state<AssEvent[]>([]);
  let currentTime = $state(0);
  let waveform = $state<WaveformData | null>(null);
  let silenceRegions = $state<SilenceRegion[]>([]);
  let activeEventId = $state<string | null>(null);
  let onlineUsers = $state<{ userId: string; username: string; color: string }[]>([]);
  // 他人光标位置：entryId → { userId, username, color }（阶段5-2）
  let otherCursors = $state<Map<string, { userId: string; username: string; color: string }>>(new Map());

  // 视图与编辑状态
  let viewFilter = $state<'all' | 'mine' | 'by-assignee'>('all'); // 「所有」/「只看自己」/「按负责人」
  let selectedAssigneeFilter = $state<string | null>(null);        // 「按负责人」下拉选中的 userId
  let selectedId = $state<string | null>(null);   // 当前选中行
  let editingId = $state<string | null>(null);    // 当前编辑行
  let editingText = $state('');                    // 编辑中的文本
  let editingOriginalText = $state('');            // 阶段5-3：进入编辑时的原始文本，用于会话级 diff
  let realtimeSave = $state(true);                 // 实时保存开关
  let pendingChanges = $state<Record<string, string>>({}); // 非实时模式下的待保存改动

  // ===== 工作分配（阶段4）=====
  // 批量指派弹窗
  let showAssignModal = $state(false);
  let assignTargetIds = $state<string[]>([]);      // 待指派的 event ids
  let assignPickedUserId = $state<string | null>(null);
  // 波形拖选指派（方案 A）
  let showWaveformAssignModal = $state(false);
  let waveformPickRange = $state<{ start: number; end: number } | null>(null);
  let waveformPickUserId = $state<string | null>(null);
  let waveformDragMode = $state(false);            // 波形拖选模式开关

  // ===== 成员管理面板（阶段3）=====
  let showMembersModal = $state(false);
  let newMemberUsername = $state('');
  let newMemberRole = $state<MemberRole>('narrator');
  let membersRefreshedAt = $state(0); // 强制刷新派生
  let memberOperationMsg = $state('');

  // 视频放大态：false=缩小态（适配内容），true=标准 16:9（560~960px）
  let videoExpanded = $state(false);

  // 「设定我的范围」：1-based 行号区间
  let myRange = $state<{ start: number; end: number } | null>(null);
  let showRangeModal = $state(false);
  let rangeStartInput = $state('');
  let rangeEndInput = $state('');

  // 行勾选集合（基于 e.id）
  let checkedIds = $state<Set<string>>(new Set());

  // 内联批注：当前展开输入框的 eventId
  let inlineReviewEventId = $state<string | null>(null);
  let inlineReviewText = $state('');

  // 上传状态
  let uploadingVideo = $state(false);
  let uploadProgress = $state('');
  let currentVideoSrc = $state(videoSrc);

  let videoPlayer: VideoPlayer | null = $state(null);
  let assInput: HTMLInputElement | null = $state(null);
  let videoInput: HTMLInputElement | null = $state(null);
  let tableBodyEl: HTMLElement | null = $state(null);

  const STATUS_LABELS: Record<EventStatus, string> = {
    empty: '空白', draft: '初稿', peer_review: '审阅中',
    revision_needed: '需修改', approved: '已通过', locked: '已锁定', deleted: '已删除',
  };
  const STATUS_COLORS: Record<EventStatus, string> = {
    empty: '#8c959f', draft: '#0969da', peer_review: '#d29922',
    revision_needed: '#cf222e', approved: '#1a7f37', locked: '#57606a', deleted: '#8c959f',
  };

  // 订阅 Yjs
  function observeEvents() {
    const yEvents = doc.getArray('events');
    const updateFromYjs = () => { events = exportEvents(doc); };
    yEvents.observeDeep(updateFromYjs);
    const onAwarenessChange = () => {
      onlineUsers = getOnlineUsers(provider);
      otherCursors = getOtherCursors(provider, userId);
    };
    provider.awareness.on('change', onAwarenessChange);
    onlineUsers = getOnlineUsers(provider);
    otherCursors = getOtherCursors(provider, userId);
    updateFromYjs();
    return () => {
      yEvents.unobserveDeep(updateFromYjs);
      provider.awareness.off('change', onAwarenessChange);
    };
  }
  let unobserve: (() => void) | null = null;
  onMount(() => { unobserve = observeEvents(); });

  // ===== 行级锁兜底解锁（阶段5-1）=====
  // 编辑中离开页面 / 切到后台 / 关闭标签页时，必须清理 awareness.cursor，避免「幽灵锁」
  function releaseMyLock() {
    if (editingId) unlockEntry(provider);
  }
  onDestroy(() => {
    unobserve?.();
    unobserveEditHistory?.();
    releaseMyLock();
  });
  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      // 切到后台：释放锁，避免幽灵锁
      releaseMyLock();
    } else if (document.visibilityState === 'visible' && editingId) {
      // 切回前台：若仍在编辑态，重新加锁
      lockEntry(provider, editingId);
    }
  }
  function onBeforeUnload() { releaseMyLock(); }

  // ===== 修改追踪（阶段5-3）=====
  // recentEditorsByEvent: entryId → 最近一次修改人 { userId, username, timestamp }
  let recentEditorsByEvent = $state<Map<string, { userId: string; username: string; timestamp: number }>>(new Map());
  // 历史弹窗：当前查看的 eventId
  let historyViewingId = $state<string | null>(null);
  let historyEntries = $state<EditHistoryEntryWithEvent[]>([]);

  function refreshRecentEditors() {
    const editHistoryMap = doc.getMap<Y.Array<unknown>>('editHistory');
    const next = new Map<string, { userId: string; username: string; timestamp: number }>();
    editHistoryMap.forEach((arr, eventId) => {
      if (arr.length === 0) return;
      const last = arr.get(arr.length - 1) as Y.Map<unknown>;
      next.set(eventId, {
        userId: last.get('userId') as string,
        username: last.get('username') as string,
        timestamp: last.get('timestamp') as number,
      });
    });
    recentEditorsByEvent = next;
  }
  let unobserveEditHistory: (() => void) | null = null;
  function observeEditHistory() {
    const editHistoryMap = doc.getMap<Y.Array<unknown>>('editHistory');
    const handler = () => refreshRecentEditors();
    editHistoryMap.observeDeep(handler);
    refreshRecentEditors();
    return () => { editHistoryMap.unobserveDeep(handler); };
  }
  onMount(() => { unobserveEditHistory = observeEditHistory(); });

  // 打开某行的修改历史弹窗
  function openHistory(eventId: string) {
    historyViewingId = eventId;
    // getEditHistory 返回纯数据，但 field 类型 narrower；这里转成 WithEvent 形式
    const raw = getEditHistory(doc, eventId);
    historyEntries = raw.map(r => ({ ...r, eventId }));
  }
  function closeHistory() {
    historyViewingId = null;
    historyEntries = [];
  }
  // 字段中文标签
  const FIELD_LABELS: Record<string, string> = {
    text: '正文', start: '开始时间', end: '结束时间', status: '状态',
  };
  function formatHistoryTime(ts: number): string {
    return new Date(ts).toLocaleString();
  }
  function lastEditorOf(eventId: string): { userId: string; username: string; timestamp: number } | null {
    return recentEditorsByEvent.get(eventId) ?? null;
  }

  // 视频加载后向后端拉取 FFmpeg 生成的波形 + 静音段
  // 后台 FFmpeg 任务可能还在处理，前端轮询直到 ready
  let waveformPolling = false;
  let videoDuration = 0; // video metadata 的权威时长，用于校准波形 duration

  async function onVideoLoaded(e: CustomEvent<number> | undefined) {
    // VideoPlayer dispatch('loadedmetadata', duration) 传来的 video 权威时长
    if (e?.detail) videoDuration = e.detail;
    if (!currentVideoSrc) return;
    if (waveformPolling) return;
    waveformPolling = true;
    try {
      const url = `/api/files/video/${projectId}/waveform`;
      // 轮询：最多 120 次 × 2s = 4 分钟
      for (let i = 0; i < 120; i++) {
        const res = await fetch(url);
        if (!res.ok) {
          // 404 = 视频未上传，停止轮询
          break;
        }
        const data = await res.json();
        if (data.status === 'ready') {
          // 后端 peaks 是 number[]，转 Float32Array 与 WaveformRenderer 兼容
          const peaks = new Float32Array(data.peaks?.length || 0);
          if (Array.isArray(data.peaks)) {
            for (let j = 0; j < data.peaks.length; j++) peaks[j] = data.peaks[j];
          }
          // 关键：duration 用 video metadata 的权威值（而非 FFmpeg WAV 的值），
          // 确保波形时间轴与 <video> 时间轴完全一致，播放头位置精确对齐。
          const finalDuration = videoDuration || data.duration || 0;
          waveform = {
            peaks,
            duration: finalDuration,
            sampleRate: 8000,
          };
          // 后端 FFmpeg silencedetect 精度更高，直接用
          const segs: SilenceRegion[] = Array.isArray(data.silenceSegments)
            ? data.silenceSegments.map((s: any) => ({ start: s.start, end: s.end }))
            : [];
          silenceRegions = markOccupiedRegions(segs, events);
          uploadProgress = '波形加载完成';
          break;
        }
        // status === 'processing' → 等待
        uploadProgress = `波形生成中... (${i * 2}s)`;
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (e) {
      console.error('波形拉取失败:', e);
      uploadProgress = '波形拉取失败，可继续编辑';
    } finally {
      waveformPolling = false;
      setTimeout(() => { uploadProgress = ''; }, 3000);
    }
  }

  $effect(() => {
    // 后端 FFmpeg 已返回精确静音段时不再用前端估算覆盖；
    // 仅当波形已加载但静音段为空（例如后端 silencedetect 未跑或无静音）时降级估算
    if (waveform && events.length > 0 && silenceRegions.length === 0) {
      silenceRegions = markOccupiedRegions(detectSilence(waveform.peaks, waveform.duration), events);
    }
  });

  // 视图过滤后的字幕列表
  // - 「所有」：显示全部非 deleted 行
  // - 「只看自己」：仅显示 _assignedTo === userId
  // - 「按负责人」：仅显示 _assignedTo === selectedAssigneeFilter（含未分配选项）
  // - 范围过滤：若设定了 myRange（1-based 行号区间），同时按 events 全局索引过滤
  //   （范围基于 events 原始顺序，与视图无关，保证设定后切换视图仍一致）
  let filteredEvents = $derived.by<AssEvent[]>(() => {
    let list: AssEvent[];
    if (viewFilter === 'mine') {
      list = events.filter(e => e._assignedTo === userId);
    } else if (viewFilter === 'by-assignee') {
      if (selectedAssigneeFilter === '__unassigned__') {
        list = events.filter(e => e._assignedTo === null || e._assignedTo === undefined);
      } else if (selectedAssigneeFilter) {
        list = events.filter(e => e._assignedTo === selectedAssigneeFilter);
      } else {
        list = events.slice();
      }
    } else {
      list = events.slice();
    }
    if (myRange) {
      // 范围基于全量 events 的 1-based 行号
      const idsInRange = new Set<string>();
      for (let i = myRange.start - 1; i <= myRange.end - 1 && i < events.length; i++) {
        if (i >= 0) idsInRange.add(events[i].id);
      }
      list = list.filter(e => idsInRange.has(e.id));
    }
    return list;
  });

  // 项目成员（合并后端 members 列表 + 在线 awareness 用户，保证显示完整）
  let allKnownMembers = $derived.by<ProjectMember[]>(() => {
    const map = new Map<string, ProjectMember>();
    for (const m of members) {
      map.set(m.userId, m);
    }
    // 在线 awareness 用户若不在 members 列表里也补上（按 narrator 默认）
    for (const u of onlineUsers) {
      if (!map.has(u.userId)) {
        map.set(u.userId, {
          userId: u.userId,
          username: u.username,
          role: 'narrator',
          joinedAt: 0,
        });
      }
    }
    return Array.from(map.values());
  });

  // 范围边界行 id 集合（用于高亮）
  let rangeBoundaryIds = $derived.by<Set<string>>(() => {
    const s = new Set<string>();
    if (myRange) {
      const si = myRange.start - 1;
      const ei = myRange.end - 1;
      if (si >= 0 && si < events.length) s.add(events[si].id);
      if (ei >= 0 && ei < events.length) s.add(events[ei].id);
    }
    return s;
  });

  // 权限判断：当前用户能否编辑该条
  // 角色矩阵：owner/manager/reviewer 可编辑他人行，narrator 仅自己行
  function canEdit(e: AssEvent): boolean {
    if (e._status === 'deleted') return false;
    const isMine = e._assignedTo === userId;
    if (isMine) return hasPermission(myRole, 'edit_own_rows');
    // 他人行：需具备 edit_others_rows 权限
    return hasPermission(myRole, 'edit_others_rows');
  }

  // 权限工具
  function can(perm: Permission): boolean {
    return hasPermission(myRole, perm);
  }

  // ===== 「设定我的范围」弹窗 =====
  function openRangeModal() {
    rangeStartInput = myRange ? String(myRange.start) : '1';
    rangeEndInput = myRange ? String(myRange.end) : String(Math.max(1, events.length));
    showRangeModal = true;
  }
  function applyRange() {
    const s = parseInt(rangeStartInput, 10);
    const e = parseInt(rangeEndInput, 10);
    if (!Number.isFinite(s) || !Number.isFinite(e) || s < 1 || e < s || s > events.length) {
      alert('行号无效：起始 ≥ 1，结束 ≥ 起始，且不超过总行数');
      return;
    }
    myRange = { start: s, end: Math.min(e, events.length) };
    showRangeModal = false;

    // 范围内所有行的复选框自动勾选
    const next = new Set<string>();
    for (let i = myRange.start - 1; i <= myRange.end - 1 && i < events.length; i++) {
      if (i >= 0) next.add(events[i].id);
    }
    checkedIds = next;

    // 表格滚动定位至该范围起始行
    const startId = events[myRange.start - 1]?.id;
    if (startId) {
      // 双 rAF：第一帧让 Svelte 应用 myRange 过滤后的 DOM 更新，第二帧再滚动
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = tableBodyEl?.querySelector(`[data-row-id="${startId}"]`);
          el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        });
      });
    }
  }
  function clearRange() {
    myRange = null;
    showRangeModal = false;
  }

  // ===== 行勾选机制 =====
  function toggleCheck(id: string) {
    const next = new Set(checkedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    checkedIds = next;
  }
  function toggleCheckAll() {
    if (filteredEvents.length > 0 && checkedIds.size >= filteredEvents.length) {
      // 全部已勾选 → 清空（仅清当前可见集合）
      const next = new Set(checkedIds);
      filteredEvents.forEach(e => next.delete(e.id));
      checkedIds = next;
    } else {
      // 全选当前可见集合
      const next = new Set(checkedIds);
      filteredEvents.forEach(e => next.add(e.id));
      checkedIds = next;
    }
  }
  let allFilteredChecked = $derived(
    filteredEvents.length > 0 && filteredEvents.every(e => checkedIds.has(e.id))
  );
  // 勾选行对应的 AssEvent（用于 AI 检测范围）
  let checkedEvents = $derived(events.filter(e => checkedIds.has(e.id)));

  // ===== 内联批注 =====
  function openInlineReview(eventId: string) {
    inlineReviewEventId = eventId;
    inlineReviewText = '';
  }
  function closeInlineReview() {
    inlineReviewEventId = null;
    inlineReviewText = '';
  }
  function submitInlineReview(eventId: string) {
    const text = inlineReviewText.trim();
    if (!text) return;
    addComment(doc, eventId, {
      authorId: userId,
      authorName: username,
      content: text,
    });
    inlineReviewText = '';
    inlineReviewEventId = null;
  }
  // 取某行的未解决批注（用于行前头像标记）
  function reviewAuthorsOf(eventId: string): ReviewComment[] {
    try {
      return getComments(doc, eventId).filter(c => !c.resolved);
    } catch {
      return [];
    }
  }
  // 头像背景色（与在线用户头像一致，基于 userId 哈希）
  const AVATAR_COLORS = ['#0969da', '#1a7f37', '#cf222e', '#d29922', '#57606a', '#8250df', '#1f6feb', '#a371f7'];
  function avatarColor(id: string): string {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }
  function initialOf(name: string): string {
    return (name || '?').trim().charAt(0).toUpperCase();
  }

  // 被他人锁定
  function getLockedByOther(eventId: string): string | null {
    const lockHolder = getLockHolder(provider, eventId, userId);
    if (!lockHolder) return null;
    return onlineUsers.find(u => u.userId === lockHolder)?.username ?? lockHolder;
  }

  // 他人正在编辑此行？（阶段5-2：用于头像气泡与行视觉提示）
  function cursorUserOf(eventId: string): { userId: string; username: string; color: string } | null {
    return otherCursors.get(eventId) ?? null;
  }

  // 负责人显示名
  function assigneeName(e: AssEvent): string {
    if (!e._assignedTo) return '未分配';
    if (e._assignedTo === userId) return '我';
    return onlineUsers.find(u => u.userId === e._assignedTo)?.username ?? e._assignedTo.slice(0, 6);
  }

  // ===== 交互 =====
  function onSeek(time: number) {
    videoPlayer?.seekTo(time);
    currentTime = time;
  }

  // 点击行：选中 + 视频跳转
  function selectRow(e: AssEvent) {
    selectedId = e.id;
    onSeek(e.start);
  }

  // 双击文本/Enter：进入编辑（仅自己负责的可编辑）
  function startEdit(e: AssEvent) {
    if (!canEdit(e)) return; // 权限校验
    const locked = getLockedByOther(e.id);
    if (locked) return;
    const parsed = parseInlineTags(e.text);
    editingText = parsed.cleanText;
    editingOriginalText = e.text; // 阶段5-3：记录原始文本用于 diff
    editingId = e.id;
    selectedId = e.id;
    lockEntry(provider, e.id);
  }

  function saveEdit() {
    if (!editingId) return;
    const e = events.find(x => x.id === editingId);
    if (!e) { editingId = null; return; }
    const parsed = parseInlineTags(e.text);
    const newText = parsed.tags.length > 0 ? parsed.tags.join('') + editingText : editingText;
    // 阶段5-3：文本有变化才记录修改历史（按编辑会话粒度，避免实时模式逐键噪音）
    if (newText !== editingOriginalText) {
      const oldText = editingOriginalText;
      if (realtimeSave) {
        updateText(doc, editingId, newText, userId, myRole ?? undefined);
      } else {
        pendingChanges = { ...pendingChanges, [editingId]: newText };
      }
      recordEdit(doc, editingId, 'text', oldText, newText, userId, username);
    } else if (!realtimeSave) {
      pendingChanges = { ...pendingChanges, [editingId]: newText };
    }
    editingId = null;
    editingOriginalText = '';
    unlockEntry(provider);
  }

  function cancelEdit() {
    editingId = null;
    editingOriginalText = '';
    unlockEntry(provider);
  }

  // 实时保存模式：输入时即时保存（不记历史，saveEdit 时统一记一次会话级 diff）
  function onTextInput() {
    if (!realtimeSave || !editingId) return;
    const e = events.find(x => x.id === editingId);
    if (!e) return;
    const parsed = parseInlineTags(e.text);
    const newText = parsed.tags.length > 0 ? parsed.tags.join('') + editingText : editingText;
    updateText(doc, editingId, newText, userId, myRole ?? undefined);
  }

  // 非实时模式：统一保存自己负责的所有待保存改动
  function saveAllMine() {
    for (const [id, text] of Object.entries(pendingChanges)) {
      const e = events.find(x => x.id === id);
      const oldText = e?.text ?? '';
      updateText(doc, id, text, userId, myRole ?? undefined);
      if (oldText !== text) recordEdit(doc, id, 'text', oldText, text, userId, username);
    }
    pendingChanges = {};
  }

  // 状态流转
  function onStatusChange(e: AssEvent, status: EventStatus) {
    const oldStatus = e._status;
    const ok = transitionStatus(doc, e.id, status, userId, myRole ?? undefined);
    if (ok && oldStatus !== status) {
      recordEdit(doc, e.id, 'status', oldStatus, status, userId, username);
    }
  }

  // 键盘导航：上下键切换行，Enter编辑，Esc取消
  function onKeydown(e: KeyboardEvent) {
    // 编辑中时不拦截（textarea 自己处理）
    if (editingId) {
      if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
      else if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); saveEdit(); }
      return;
    }
    if (!selectedId || filteredEvents.length === 0) return;
    const idx = filteredEvents.findIndex(x => x.id === selectedId);
    if (idx === -1) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = filteredEvents[Math.min(idx + 1, filteredEvents.length - 1)];
      selectRow(next);
      scrollRowIntoView(next.id);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = filteredEvents[Math.max(idx - 1, 0)];
      selectRow(prev);
      scrollRowIntoView(prev.id);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cur = filteredEvents[idx];
      startEdit(cur);
    }
  }

  function scrollRowIntoView(id: string) {
    requestAnimationFrame(() => {
      const el = tableBodyEl?.querySelector(`[data-row-id="${id}"]`);
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  // 当前播放位置高亮
  $effect(() => {
    const active = events.find(e =>
      currentTime >= e.start && currentTime <= e.end && e._status !== 'deleted',
    );
    activeEventId = active?.id ?? null;
  });

  // ===== 导入 ASS（含方案 B 自动归属）=====
  // ASS 自动归属规则（按优先级）：
  //   1. Style 名含 @用户名 后缀（如 "Narration@张三"）→ 指派给该用户名对应的成员
  //   2. Style 名直接等于某成员用户名（如 "张三"）→ 指派给该成员
  //   3. Actor/Name 字段等于某成员用户名 → 指派给该成员
  //   4. Layer 字段映射（如 layer=2 表示第二个成员）→ 按成员列表顺序映射（少用）
  //   5. 无匹配 → _assignedTo = null，留待手动指派
  // 解析后弹出归属确认弹窗，可逐行修改再确认导入
  let showImportConfirm = $state(false);
  let pendingImportEvents = $state<AssEvent[]>([]);
  let importMatchStats = $state<{ matched: number; unmatched: number }>({ matched: 0, unmatched: 0 });

  function resolveAssigneeByStyle(style: string, name: string, memberList: ProjectMember[]): string | null {
    // 规则 1：Style 名含 @用户名 后缀
    if (style) {
      const atIdx = style.lastIndexOf('@');
      if (atIdx >= 0) {
        const candidate = style.substring(atIdx + 1).trim();
        const m = memberList.find(x => x.username === candidate);
        if (m) return m.userId;
      }
      // 规则 2：Style 名直接等于用户名
      const m2 = memberList.find(x => x.username === style.trim());
      if (m2) return m2.userId;
    }
    // 规则 3：Actor/Name 字段
    if (name) {
      const m3 = memberList.find(x => x.username === name.trim());
      if (m3) return m3.userId;
    }
    return null;
  }

  async function onImportAss(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files?.[0]) return;
    const file = input.files[0];
    const text = await file.text();
    const assDoc = parseAss(text);
    // 自动归属：基于当前已知成员列表
    const memberList = allKnownMembers;
    let matched = 0;
    const enriched = assDoc.events.map(ev => {
      const assigneeId = resolveAssigneeByStyle(ev.style, ev.name, memberList);
      if (assigneeId) { matched++; return { ...ev, _assignedTo: assigneeId }; }
      return { ...ev, _assignedTo: ev._assignedTo ?? null };
    });
    pendingImportEvents = enriched;
    importMatchStats = { matched, unmatched: enriched.length - matched };
    showImportConfirm = true;
    input.value = '';
  }

  // 确认导入（用户在弹窗里可能已修改归属）
  function confirmImport() {
    importEvents(doc, pendingImportEvents);
    showImportConfirm = false;
    pendingImportEvents = [];
  }

  function cancelImport() {
    showImportConfirm = false;
    pendingImportEvents = [];
  }

  // 在导入确认弹窗里手动改某行的归属
  function setPendingAssignee(idx: number, userId: string | null) {
    const next = pendingImportEvents.slice();
    next[idx] = { ...next[idx], _assignedTo: userId };
    pendingImportEvents = next;
  }

  // ===== 批量指派（方案 B 手动）=====
  function openAssignModal() {
    if (!can('assign_work')) {
      alert('无分配工作权限（需 owner/manager 角色）');
      return;
    }
    if (checkedIds.size === 0) {
      alert('请先勾选要指派的行');
      return;
    }
    assignTargetIds = Array.from(checkedIds);
    assignPickedUserId = null;
    showAssignModal = true;
  }

  function confirmAssign() {
    if (!assignPickedUserId) {
      alert('请选择负责人');
      return;
    }
    assignEventsBulk(doc, assignTargetIds, assignPickedUserId);
    showAssignModal = false;
    assignTargetIds = [];
    assignPickedUserId = null;
  }

  function cancelAssign() {
    showAssignModal = false;
    assignTargetIds = [];
    assignPickedUserId = null;
  }

  // 解除指派
  function clearAssign() {
    if (checkedIds.size === 0) {
      alert('请先勾选要解除指派的行');
      return;
    }
    assignEventsBulk(doc, Array.from(checkedIds), null);
  }

  // ===== 波形拖选指派（方案 A）=====
  function openWaveformAssignModal(range: { start: number; end: number }) {
    if (!can('assign_work')) {
      alert('无分配工作权限（需 owner/manager 角色）');
      return;
    }
    waveformPickRange = range;
    waveformPickUserId = null;
    showWaveformAssignModal = true;
  }

  function confirmWaveformAssign() {
    if (!waveformPickRange) return;
    if (!waveformPickUserId) {
      alert('请选择负责人');
      return;
    }
    // 在该区间创建一个新条目并指派
    const newId = createEvent(doc, {
      layer: 1,
      start: waveformPickRange.start,
      end: waveformPickRange.end,
      style: 'Narration',
      text: '',
      _status: 'empty',
      _assignedTo: waveformPickUserId,
    });
    selectedId = newId;
    showWaveformAssignModal = false;
    waveformPickRange = null;
    waveformPickUserId = null;
  }

  function cancelWaveformAssign() {
    showWaveformAssignModal = false;
    waveformPickRange = null;
    waveformPickUserId = null;
  }

  // ===== 上传视频（带进度条，XHR 实现 onUploadProgress）=====
  let uploadPct = $state(0); // 0~100，-1 表示不在上传
  async function onUploadVideo(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files?.[0]) return;
    const file = input.files[0];
    uploadingVideo = true;
    uploadPct = 0;
    uploadProgress = `上传中: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
    try {
      const formData = new FormData();
      formData.append('file', file);

      // 用 XHR 获得 upload progress 事件（fetch 不支持上传进度）
      const data: any = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/projects/${projectId}/video`);
        xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) {
            uploadPct = Math.round((ev.loaded / ev.total) * 100);
            uploadProgress = `上传中 ${uploadPct}%: ${file.name}`;
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText)); }
            catch { reject(new Error(`HTTP ${xhr.status}`)); }
          } else {
            let msg = `HTTP ${xhr.status}`;
            try {
              const d = JSON.parse(xhr.responseText);
              if (d?.detail?.[0]?.msg) msg = d.detail[0].msg;
            } catch { /* ignore */ }
            reject(new Error(msg));
          }
        };
        xhr.onerror = () => reject(new Error('网络错误'));
        xhr.send(formData);
      });

      // 上传成功 → 立即把后端返回的 URL 赋给 video src，自动加载
      uploadPct = 100;
      uploadProgress = '上传完成，正在加载视频...';
      currentVideoSrc = data.videoUrl;
      // 短暂展示 100% 后清空进度条
      setTimeout(() => { uploadPct = -1; }, 800);
    } catch (err: any) {
      uploadProgress = `上传失败: ${err.message}`;
      uploadPct = -1;
    } finally {
      uploadingVideo = false;
      input.value = '';
      // 上传状态文案保留 3 秒后清空（波形进度另算）
      setTimeout(() => { if (uploadPct < 0) uploadProgress = ''; }, 3000);
    }
  }

  // 把自己负责的部分分配给自己（用于导入后认领）
  function claimSelected() {
    if (!selectedId) return;
    assignEvent(doc, selectedId, userId);
  }

  // ===== 成员管理面板（阶段3，仅 owner 可见）=====
  // 候选成员：在线但尚未在 members 列表里的用户
  let candidateMembers = $derived.by<ProjectMember[]>(() => {
    const memberIds = new Set(members.map(m => m.userId));
    return allKnownMembers.filter(m => !memberIds.has(m.userId));
  });
  let pickedCandidateUserId = $state<string>('');

  async function refreshMembers() {
    try {
      const res = await fetch(`/api/projects/${projectId}/members`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        members = (data.members || []) as ProjectMember[];
        membersRefreshedAt++;
      }
    } catch (e) {
      console.error('刷新成员列表失败', e);
    }
  }

  async function addMember() {
    // 优先从候选下拉选 userId；若候选为空，回退用 username 占位（待用户系统上线后真实绑定）
    let body: any;
    if (pickedCandidateUserId) {
      const cand = allKnownMembers.find(m => m.userId === pickedCandidateUserId);
      if (!cand) {
        memberOperationMsg = '候选成员不存在';
        return;
      }
      body = { username: cand.username, role: newMemberRole, user_id: cand.userId };
    } else if (newMemberUsername.trim()) {
      body = { username: newMemberUsername.trim(), role: newMemberRole };
    } else {
      memberOperationMsg = '请从在线列表选择成员，或输入用户名';
      return;
    }
    try {
      const res = await fetch(`/api/projects/${projectId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        memberOperationMsg = d.detail || `添加失败 (HTTP ${res.status})`;
        return;
      }
      newMemberUsername = '';
      newMemberRole = 'narrator';
      pickedCandidateUserId = '';
      memberOperationMsg = '添加成功';
      await refreshMembers();
      setTimeout(() => { memberOperationMsg = ''; }, 2000);
    } catch (e: any) {
      memberOperationMsg = e.message;
    }
  }

  async function changeMemberRole(memberUserId: string, role: MemberRole) {
    try {
      const res = await fetch(`/api/projects/${projectId}/members/${memberUserId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        memberOperationMsg = d.detail || `修改失败 (HTTP ${res.status})`;
        return;
      }
      memberOperationMsg = '角色已更新';
      await refreshMembers();
      setTimeout(() => { memberOperationMsg = ''; }, 2000);
    } catch (e: any) {
      memberOperationMsg = e.message;
    }
  }

  async function removeMember(memberUserId: string, memberName: string) {
    if (!confirm(`确认移除成员 ${memberName}？`)) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/members/${memberUserId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        memberOperationMsg = d.detail || `移除失败 (HTTP ${res.status})`;
        return;
      }
      memberOperationMsg = '成员已移除';
      await refreshMembers();
      setTimeout(() => { memberOperationMsg = ''; }, 2000);
    } catch (e: any) {
      memberOperationMsg = e.message;
    }
  }

  // ===== 面板切换（V1.5/V2 整合）=====
  type PanelName = 'none' | 'export' | 'ai' | 'review' | 'version' | 'continuity' | 'rehearsal';
  let activePanel = $state<PanelName>('none');
  function togglePanel(p: PanelName) {
    activePanel = activePanel === p ? 'none' : p;
  }

  // ===== 快捷键系统（V1.5）=====
  const shortcutManager = createShortcutManager();
  function setupShortcuts() {
    createDefaultShortcuts(shortcutManager, {
      togglePlay: () => { videoPlayer?.getIsPlaying() ? videoPlayer.pause() : videoPlayer?.play(); },
      insertRow: () => {
        if (selectedId) {
          const e = events.find(x => x.id === selectedId);
          if (e) {
            const newId = createEvent(doc, { layer: 1, start: currentTime, end: currentTime + 2, style: 'Narration', text: '', _status: 'empty', _assignedTo: userId });
            selectedId = newId;
          }
        } else {
          const newId = createEvent(doc, { layer: 1, start: currentTime, end: currentTime + 2, style: 'Narration', text: '', _status: 'empty', _assignedTo: userId });
          selectedId = newId;
        }
      },
      deleteRow: () => {
        if (!selectedId) return;
        const e = events.find(x => x.id === selectedId);
        if (!e || !canEdit(e)) return;
        if (confirm('确认软删除此行？（deleted 状态，可在状态机中恢复为 draft）')) {
          softDeleteEvent(doc, selectedId, userId, myRole ?? undefined);
          selectedId = null;
        }
      },
      splitRow: () => {
        if (!selectedId) return;
        const e = events.find(x => x.id === selectedId);
        if (!e || !canEdit(e)) return;
        const mid = currentTime;
        if (mid <= e.start || mid >= e.end) return;
        const oldEnd = e.end;
        updateTime(doc, selectedId, e.start, mid, userId, myRole ?? undefined);
        recordEdit(doc, selectedId, 'end', String(oldEnd), String(mid), userId, username);
        createEvent(doc, { layer: e.layer, start: mid, end: oldEnd, style: e.style, text: '', _status: 'empty', _assignedTo: userId });
      },
      moveDown: () => {
        if (!selectedId) return;
        const idx = filteredEvents.findIndex(x => x.id === selectedId);
        if (idx < filteredEvents.length - 1) { selectRow(filteredEvents[idx + 1]); scrollRowIntoView(filteredEvents[idx + 1].id); }
      },
      moveUp: () => {
        if (!selectedId) return;
        const idx = filteredEvents.findIndex(x => x.id === selectedId);
        if (idx > 0) { selectRow(filteredEvents[idx - 1]); scrollRowIntoView(filteredEvents[idx - 1].id); }
      },
      nudgeStartBack: () => {
        if (!selectedId) return;
        const e = events.find(x => x.id === selectedId);
        if (e && canEdit(e)) updateTime(doc, selectedId, Math.max(0, e.start - 0.1), e.end, userId, myRole ?? undefined);
      },
      nudgeStartForward: () => {
        if (!selectedId) return;
        const e = events.find(x => x.id === selectedId);
        if (e && canEdit(e)) updateTime(doc, selectedId, Math.min(e.end - 0.1, e.start + 0.1), e.end, userId, myRole ?? undefined);
      },
      nudgeEndBack: () => {
        if (!selectedId) return;
        const e = events.find(x => x.id === selectedId);
        if (e && canEdit(e)) updateTime(doc, selectedId, e.start, Math.max(e.start + 0.1, e.end - 0.1), userId, myRole ?? undefined);
      },
      nudgeEndForward: () => {
        if (!selectedId) return;
        const e = events.find(x => x.id === selectedId);
        if (e && canEdit(e)) updateTime(doc, selectedId, e.start, e.end + 0.1, userId, myRole ?? undefined);
      },
      submitForReview: () => {
        if (!selectedId) return;
        const e = events.find(x => x.id === selectedId);
        if (e && canEdit(e)) transitionStatus(doc, selectedId, 'peer_review', userId, myRole ?? undefined);
      },
      jumpNextBlank: () => {
        const r = findNextBlank(events, silenceRegions, currentTime);
        if (r.time !== null) onSeek(r.time);
        if (r.eventId) { selectedId = r.eventId; scrollRowIntoView(r.eventId); }
      },
      jumpPrevBlank: () => {
        const r = findPrevBlank(events, silenceRegions, currentTime);
        if (r.time !== null) onSeek(r.time);
        if (r.eventId) { selectedId = r.eventId; scrollRowIntoView(r.eventId); }
      },
      cancel: () => { cancelEdit(); selectedId = null; },
    });
  }
  setupShortcuts();
  onDestroy(() => shortcutManager.destroy());

  // 从 ContinuityCheck 等面板发来的跳转事件
  function handleJumpToEvent(e: { eventId: string }) {
    const target = events.find(x => x.id === e.eventId);
    if (target) { selectRow(target); scrollRowIntoView(target.id); }
  }
</script>

<svelte:window
  on:keydown={shortcutManager.handleKeyDown}
  on:visibilitychange={onVisibilityChange}
  on:beforeunload={onBeforeUnload}
/>

<div class="editor-layout" class:video-expanded={videoExpanded}>
  <!-- 左侧：视频 + 波形 + 演练 -->
  <div class="left-panel">
    <VideoPlayer
      bind:this={videoPlayer}
      src={currentVideoSrc}
      bind:currentTime
      expanded={videoExpanded}
      on:loadedmetadata={onVideoLoaded}
      on:toggleExpand={() => videoExpanded = !videoExpanded}
    />
    {#if uploadPct >= 0}
      <div class="upload-progress-bar">
        <div class="progress-track">
          <div class="progress-fill" style="width: {uploadPct}%"></div>
        </div>
        <span class="progress-pct">{uploadPct}%</span>
      </div>
    {/if}
    <WaveformDisplay
      {waveform}
      {currentTime}
      {silenceRegions}
      {events}
      dragSelectEnabled={waveformDragMode}
      on:seek={(e) => onSeek(e.detail)}
      on:createEntry={(e) => {
        const id = createEvent(doc, { layer: 1, start: e.detail.start, end: e.detail.end, style: 'Narration', text: '', _status: 'empty', _assignedTo: userId });
        selectedId = id;
      }}
      on:selectRange={(e) => openWaveformAssignModal(e.detail)}
    />
    {#if can('assign_work') && waveform}
      <button
        class="btn btn-drag-toggle"
        class:active={waveformDragMode}
        on:click={() => waveformDragMode = !waveformDragMode}
        title="切换拖选模式：拖选区间新建并指派"
      >{waveformDragMode ? '✓ 拖选模式' : '🎯 拖选指派'}</button>
    {/if}
  </div>

  <!-- 右侧：字幕表格 -->
  <div class="right-panel">
    <!-- 工具栏 -->
    <div class="toolbar">
      <div class="view-filter">
        <button class:active={viewFilter === 'all'} on:click={() => { viewFilter = 'all'; selectedAssigneeFilter = null; }}>所有</button>
        <button class:active={viewFilter === 'mine'} on:click={() => { viewFilter = 'mine'; selectedAssigneeFilter = null; }}>只看自己</button>
        <div class="filter-by-assignee">
          <button
            class:active={viewFilter === 'by-assignee'}
            on:click={() => { viewFilter = 'by-assignee'; if (!selectedAssigneeFilter) selectedAssigneeFilter = '__unassigned__'; }}
            title="按负责人筛选"
          >负责人</button>
          {#if viewFilter === 'by-assignee'}
            <select
              value={selectedAssigneeFilter ?? '__unassigned__'}
              on:change={(ev) => selectedAssigneeFilter = ev.currentTarget.value}
              title="选择负责人"
            >
              <option value="__unassigned__">未分配</option>
              {#each allKnownMembers as m (m.userId)}
                <option value={m.userId}>{m.username}{#if m.role !== 'narrator'}（{ROLE_LABELS[m.role]}）{/if}</option>
              {/each}
            </select>
          {/if}
        </div>
        <button class="btn-range" class:active={!!myRange} on:click={openRangeModal} title="设定我的范围">
          📐 范围{#if myRange} {myRange.start}-{myRange.end}{/if}
        </button>
      </div>
      <div class="toolbar-actions">
        <label class="btn btn-import">
          导入ASS
          <input type="file" accept=".ass" on:change={onImportAss} hidden />
        </label>
        {#if can('assign_work')}
          <button class="btn btn-tool" on:click={openAssignModal} title="批量指派（先勾选行）" disabled={checkedIds.size === 0}>
            指派 ({checkedIds.size})
          </button>
          <button class="btn btn-tool" on:click={clearAssign} title="解除勾选行的指派" disabled={checkedIds.size === 0}>解除</button>
        {/if}
        {#if can('manage_members')}
          <button class="btn btn-tool" on:click={() => { showMembersModal = true; refreshMembers(); }} title="成员管理">成员</button>
        {/if}
        <label class="btn btn-video" class:disabled={uploadingVideo}>
          {uploadingVideo ? '上传中...' : '上传视频'}
          <input type="file" accept="video/*" on:change={onUploadVideo} hidden disabled={uploadingVideo} bind:this={videoInput} />
        </label>
        <button class="btn btn-tool" class:active={activePanel === 'ai'} on:click={() => togglePanel('ai')} title="AI检测（基于勾选行或范围）">AI</button>
        <button class="btn btn-tool" on:click={() => { if (selectedId) openInlineReview(selectedId); }} title="批注（勾选/选中行后内联展开）" disabled={!selectedId}>批注</button>
        {#if can('version_manage')}
          <button class="btn btn-tool" class:active={activePanel === 'version'} on:click={() => togglePanel('version')} title="版本历史">版本</button>
        {/if}
        <button class="btn btn-tool" class:active={activePanel === 'continuity'} on:click={() => togglePanel('continuity')} title="衔接检查">衔接</button>
        <button class="btn btn-tool" class:active={activePanel === 'export'} on:click={() => togglePanel('export')} title="导出">导出</button>
        <button class="btn btn-rehearsal" class:active={activePanel === 'rehearsal'} on:click={() => togglePanel('rehearsal')} title="演练">演练</button>
      </div>
    </div>

    <!-- 浮层面板（V1.5/V2） -->
    {#if activePanel !== 'none'}
      <div class="panel-overlay">
        {#if activePanel === 'export'}
          <ExportPanel {events} {projectId} {authToken} />
        {:else if activePanel === 'ai'}
          <AiReviewPanel {doc} {provider} selectedEventId={selectedId} {userId} {username} {authToken} checkedEvents={checkedEvents} allEvents={events} />
        {:else if activePanel === 'version'}
          <VersionHistory {doc} {projectId} {authToken} />
        {:else if activePanel === 'continuity'}
          <ContinuityCheck {doc} {authToken} onjump={(e) => handleJumpToEvent(e)} />
        {:else if activePanel === 'rehearsal'}
          <RehearsalMode {doc} {provider} videoPlayer={videoPlayer} {projectId} {userId} {username} {events} {currentTime} {authToken} />
        {/if}
        <button class="panel-close" on:click={() => activePanel = 'none'}>×</button>
      </div>
    {/if}

    {#if uploadProgress}
      <div class="upload-status">{uploadProgress}</div>
    {/if}

    <!-- 实时保存开关 + 保存按钮 -->
    <div class="save-bar">
      <label class="toggle">
        <input type="checkbox" bind:checked={realtimeSave} />
        <span>实时保存</span>
      </label>
      {#if !realtimeSave && Object.keys(pendingChanges).length > 0}
        <button class="btn btn-save-all" on:click={saveAllMine}>
          保存我的改动 ({Object.keys(pendingChanges).length})
        </button>
      {/if}
      <span class="online-count">🟢 {onlineUsers.length} 人在线</span>
      <span class="checked-count">☑ 已勾选 {checkedIds.size}</span>
    </div>

    <!-- 在线用户头像（圆形昵称首字，绑定真实 awareness） -->
    <div class="online-users">
      {#each onlineUsers as u (u.userId)}
        <div class="avatar" style="background: {avatarColor(u.userId)}" title={u.username}>
          {initialOf(u.username)}
        </div>
      {/each}
    </div>

    <!-- 字幕表格 -->
    <div class="table-wrap" bind:this={tableBodyEl}>
      <table class="subtitle-table">
        <thead>
          <tr>
            <th class="col-check">
              <input type="checkbox" checked={allFilteredChecked} on:change={toggleCheckAll} title="全选/取消全选当前可见行" />
            </th>
            <th class="col-idx">#</th>
            <th class="col-start">开始</th>
            <th class="col-end">结束</th>
            <th class="col-type">类型</th>
            <th class="col-assignee">负责</th>
            <th class="col-text">文本</th>
            <th class="col-status">状态</th>
          </tr>
        </thead>
        <tbody>
          {#each filteredEvents as e, i (e.id)}
            {@const reviews = reviewAuthorsOf(e.id)}
            {@const cursorUser = cursorUserOf(e.id)}
            <tr
              data-row-id={e.id}
              class="row"
              class:selected={selectedId === e.id}
              class:active={activeEventId === e.id}
              class:checked={checkedIds.has(e.id)}
              class:range-boundary={rangeBoundaryIds.has(e.id)}
              class:readonly={!canEdit(e)}
              class:being-edited={!!cursorUser}
              style="--status-color: {STATUS_COLORS[e._status]}; --cursor-color: {cursorUser?.color ?? 'transparent'}"
              on:click={() => selectRow(e)}
              on:dblclick={() => startEdit(e)}
              role="button"
              tabindex="0"
            >
              <td class="col-check" on:click|stopPropagation>
                <input type="checkbox" checked={checkedIds.has(e.id)} on:change={() => toggleCheck(e.id)} title="勾选此行" />
              </td>
              <td class="col-idx">
                <div class="idx-cell">
                  <span>{i + 1}</span>
                  {#if cursorUser}
                    <div class="cursor-avatar" title="{cursorUser.username} 正在编辑" style="background: {cursorUser.color}">
                      {initialOf(cursorUser.username)}
                    </div>
                  {:else if reviews.length > 0}
                    <div class="review-avatars" title="{reviews.length} 条未解决批注">
                      {#each reviews.slice(0, 2) as c (c.id)}
                        <div class="avatar avatar-tiny" style="background: {avatarColor(c.authorId)}" title="{c.authorName}: {c.content}">
                          {initialOf(c.authorName)}
                        </div>
                      {/each}
                      {#if reviews.length > 2}<span class="more">+{reviews.length - 2}</span>{/if}
                    </div>
                  {/if}
                </div>
              </td>
              <td class="col-start time-cell" on:click|stopPropagation={() => onSeek(e.start)}>{formatDisplayTime(e.start)}</td>
              <td class="col-end time-cell" on:click|stopPropagation={() => onSeek(e.end)}>{formatDisplayTime(e.end)}</td>
              <td class="col-type">
                <span class="layer-badge layer-{e.layer}">{e.layer === 0 ? '对白' : '口述'}</span>
              </td>
              <td class="col-assignee">{assigneeName(e)}</td>
              <td class="col-text">
                {#if editingId === e.id}
                  <textarea
                    bind:value={editingText}
                    on:input={onTextInput}
                    on:keydown={(ev) => ev.stopPropagation()}
                    rows="2"
                    placeholder="输入口述文本..."
                  ></textarea>
                {:else}
                  {@const parsed = parseInlineTags(e.text)}
                  {@const lastEditor = lastEditorOf(e.id)}
                  <div class="text-cell" class:empty={!parsed.cleanText}>
                    {#if parsed.tags.length > 0}
                      <span class="tags-readonly">{parsed.tags.join('')}</span>
                    {/if}
                    <span class="text-body">{parsed.cleanText || (canEdit(e) ? '(空，双击编辑)' : '(空)')}</span>
                  </div>
                  {#if !canEdit(e)}
                    <span class="lock-icon" title="他人负责，只读">🔒</span>
                  {/if}
                  {#if lastEditor}
                    <button
                      class="edit-history-btn"
                      title="最近修改：{lastEditor.username} · {formatHistoryTime(lastEditor.timestamp)}（点击查看修改历史）"
                      style="--editor-color: {avatarColor(lastEditor.userId)}"
                      on:click|stopPropagation={() => openHistory(e.id)}
                    >{initialOf(lastEditor.username)}</button>
                  {/if}
                {/if}
              </td>
              <td class="col-status">
                {#if canEdit(e)}
                  <select
                    value={e._status}
                    on:change={(ev) => onStatusChange(e, ev.currentTarget.value as EventStatus)}
                    on:click|stopPropagation
                  >
                    {#each Object.entries(STATUS_LABELS) as [value, label]}
                      <option value={value}>{label}</option>
                    {/each}
                  </select>
                {:else}
                  <span class="status-badge" style="background: {STATUS_COLORS[e._status]}">{STATUS_LABELS[e._status]}</span>
                {/if}
              </td>
            </tr>
            {#if inlineReviewEventId === e.id}
              <tr class="inline-review-row">
                <td colspan="8">
                  <div class="inline-review-box">
                    <div class="avatar avatar-sm" style="background: {avatarColor(userId)}">{initialOf(username)}</div>
                    <textarea
                      bind:value={inlineReviewText}
                      placeholder="对此行添加批注... (Ctrl+Enter 提交)"
                      rows="2"
                      on:keydown={(ev) => {
                        ev.stopPropagation();
                        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); submitInlineReview(e.id); }
                        if (ev.key === 'Escape') { ev.preventDefault(); closeInlineReview(); }
                      }}
                    ></textarea>
                    <button class="btn btn-primary" on:click={() => submitInlineReview(e.id)} disabled={!inlineReviewText.trim()}>提交</button>
                    <button class="btn btn-cancel" on:click={closeInlineReview}>取消</button>
                  </div>
                  {#if reviews.length > 0}
                    <div class="inline-review-list">
                      {#each reviews as c (c.id)}
                        <div class="inline-comment">
                          <div class="avatar avatar-tiny" style="background: {avatarColor(c.authorId)}">{initialOf(c.authorName)}</div>
                          <div class="comment-body">
                            <span class="comment-author">{c.authorName}</span>
                            <span class="comment-content">{c.content}</span>
                          </div>
                        </div>
                      {/each}
                    </div>
                  {/if}
                </td>
              </tr>
            {/if}
          {:else}
            <tr><td colspan="8" class="empty-row">
              {#if events.length === 0}
                暂无字幕，点击「导入ASS」开始
              {:else}
                你还没有被分配字幕段落
              {/if}
            </td></tr>
          {/each}
        </tbody>
      </table>
    </div>

    <!-- 设定我的范围 弹窗 -->
    {#if showRangeModal}
      <div class="modal-overlay" on:click|self={clearRange}>
        <div class="modal-box" role="dialog" aria-modal="true">
          <div class="modal-title">设定我的范围</div>
          <div class="modal-desc">输入起止行号（1-based，基于全表行号）。确认后表格过滤至该区间，「只看自己」模式绑定此范围。</div>
          <div class="modal-form">
            <label>起始行
              <input type="number" min="1" max={events.length} bind:value={rangeStartInput} />
            </label>
            <span class="range-sep">—</span>
            <label>结束行
              <input type="number" min="1" max={events.length} bind:value={rangeEndInput} />
            </label>
          </div>
          <div class="modal-actions">
            <button class="btn btn-cancel" on:click={clearRange}>清除范围</button>
            <button class="btn btn-primary" on:click={applyRange}>确认</button>
          </div>
        </div>
      </div>
    {/if}

    <!-- 导入 ASS 确认弹窗（含自动归属复核）-->
    {#if showImportConfirm}
      <div class="modal-overlay modal-wide" on:click|self={cancelImport}>
        <div class="modal-box" role="dialog" aria-modal="true">
          <div class="modal-title">导入确认 — 自动归属匹配</div>
          <div class="modal-desc">
            已解析 {pendingImportEvents.length} 条字幕。自动匹配到负责人 {importMatchStats.matched} 条，
            未匹配 {importMatchStats.unmatched} 条。可逐行修改负责人后确认导入。
            <br /><span class="hint">匹配规则：Style 名含 @用户名 后缀 → Style 名等于用户名 → Name 字段等于用户名</span>
          </div>
          <div class="import-table-wrap">
            <table class="import-table">
              <thead>
                <tr>
                  <th>#</th><th>开始</th><th>Style</th><th>Name</th><th>文本</th><th>负责人</th>
                </tr>
              </thead>
              <tbody>
                {#each pendingImportEvents as ev, i (ev.id)}
                  <tr>
                    <td>{i + 1}</td>
                    <td>{formatDisplayTime(ev.start)}</td>
                    <td class="cell-style">{ev.style}</td>
                    <td class="cell-name">{ev.name || '—'}</td>
                    <td class="cell-text">{stripAllTags(ev.text).slice(0, 40) || '(空)'}</td>
                    <td>
                      <select
                        value={ev._assignedTo ?? ''}
                        on:change={(e) => setPendingAssignee(i, e.currentTarget.value || null)}
                      >
                        <option value="">未分配</option>
                        {#each allKnownMembers as m (m.userId)}
                          <option value={m.userId}>{m.username}</option>
                        {/each}
                      </select>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <div class="modal-actions">
            <button class="btn btn-cancel" on:click={cancelImport}>取消</button>
            <button class="btn btn-primary" on:click={confirmImport}>确认导入</button>
          </div>
        </div>
      </div>
    {/if}

    <!-- 批量指派弹窗 -->
    {#if showAssignModal}
      <div class="modal-overlay" on:click|self={cancelAssign}>
        <div class="modal-box" role="dialog" aria-modal="true">
          <div class="modal-title">批量指派 — 共 {assignTargetIds.length} 行</div>
          <div class="modal-desc">将勾选的字幕条目指派给某位成员，被指派者获得编辑权。</div>
          <div class="modal-form">
            <label>指派给
              <select bind:value={assignPickedUserId}>
                <option value={null}>— 选择成员 —</option>
                {#each allKnownMembers as m (m.userId)}
                  <option value={m.userId}>{m.username}（{ROLE_LABELS[m.role]}）</option>
                {/each}
              </select>
            </label>
          </div>
          <div class="modal-actions">
            <button class="btn btn-cancel" on:click={cancelAssign}>取消</button>
            <button class="btn btn-primary" on:click={confirmAssign} disabled={!assignPickedUserId}>确认指派</button>
          </div>
        </div>
      </div>
    {/if}

    <!-- 波形拖选指派弹窗（方案 A）-->
    {#if showWaveformAssignModal && waveformPickRange}
      <div class="modal-overlay" on:click|self={cancelWaveformAssign}>
        <div class="modal-box" role="dialog" aria-modal="true">
          <div class="modal-title">波形拖选 — 新建并指派</div>
          <div class="modal-desc">
            在 {formatDisplayTime(waveformPickRange.start)} — {formatDisplayTime(waveformPickRange.end)}
            区间新建一条空字幕并指派给某位成员。
          </div>
          <div class="modal-form">
            <label>指派给
              <select bind:value={waveformPickUserId}>
                <option value={null}>— 选择成员 —</option>
                {#each allKnownMembers as m (m.userId)}
                  <option value={m.userId}>{m.username}（{ROLE_LABELS[m.role]}）</option>
                {/each}
              </select>
            </label>
          </div>
          <div class="modal-actions">
            <button class="btn btn-cancel" on:click={cancelWaveformAssign}>取消</button>
            <button class="btn btn-primary" on:click={confirmWaveformAssign} disabled={!waveformPickUserId}>确认</button>
          </div>
        </div>
      </div>
    {/if}

    <!-- 成员管理弹窗（仅 owner 可见）-->
    {#if showMembersModal && can('manage_members')}
      <div class="modal-overlay modal-wide" on:click|self={() => showMembersModal = false}>
        <div class="modal-box" role="dialog" aria-modal="true">
          <div class="modal-title">成员管理</div>
          <div class="modal-desc">添加成员、修改角色、移除成员。owner 不可被移除/降级。</div>

          <div class="members-add-row">
            {#if candidateMembers.length > 0}
              <select bind:value={pickedCandidateUserId} title="从在线用户中选择">
                <option value="">— 在线用户 —</option>
                {#each candidateMembers as m (m.userId)}
                  <option value={m.userId}>{m.username}</option>
                {/each}
              </select>
            {/if}
            <input type="text" bind:value={newMemberUsername} placeholder="或输入用户名（无在线用户时）" />
            <select bind:value={newMemberRole}>
              {#each Object.entries(ROLE_LABELS) as [value, label]}
                {#if value !== 'owner'}
                  <option value={value}>{label}</option>
                {/if}
              {/each}
            </select>
            <button class="btn btn-primary" on:click={addMember}>添加</button>
          </div>

          {#if memberOperationMsg}
            <div class="member-op-msg">{memberOperationMsg}</div>
          {/if}

          <div class="members-table-wrap">
            <table class="members-table">
              <thead>
                <tr><th>用户名</th><th>角色</th><th>加入时间</th><th>操作</th></tr>
              </thead>
              <tbody>
                {#each members as m (m.userId)}
                  <tr>
                    <td>
                      <div class="member-cell">
                        <div class="avatar avatar-sm" style="background: {avatarColor(m.userId)}">{initialOf(m.username)}</div>
                        <span>{m.username}{#if m.userId === userId} <span class="me-tag">我</span>{/if}</span>
                      </div>
                    </td>
                    <td>
                      {#if m.role === 'owner'}
                        <span class="role-badge role-owner">{ROLE_LABELS[m.role]}</span>
                      {:else}
                        <select
                          value={m.role}
                          on:change={(e) => changeMemberRole(m.userId, e.currentTarget.value as MemberRole)}
                        >
                          {#each Object.entries(ROLE_LABELS) as [value, label]}
                            {#if value !== 'owner'}
                              <option value={value}>{label}</option>
                            {/if}
                          {/each}
                        </select>
                      {/if}
                    </td>
                    <td>{m.joinedAt ? new Date(m.joinedAt * 1000).toLocaleString() : '—'}</td>
                    <td>
                      {#if m.role !== 'owner'}
                        <button class="btn btn-danger-sm" on:click={() => removeMember(m.userId, m.username)}>移除</button>
                      {:else}
                        <span class="hint">项目创建者</span>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>

          <div class="modal-actions">
            <button class="btn btn-cancel" on:click={() => showMembersModal = false}>关闭</button>
          </div>
        </div>
      </div>
    {/if}

    {#if historyViewingId}
      <div class="modal-overlay" on:click|self={closeHistory}>
        <div class="modal-box modal-wide" role="dialog" aria-modal="true">
          <div class="modal-header">
            <h3>修改历史</h3>
            <button class="btn btn-cancel" on:click={closeHistory}>关闭</button>
          </div>
          <div class="history-list">
            {#if historyEntries.length === 0}
              <p class="empty-tip">该行暂无修改记录</p>
            {:else}
              {#each [...historyEntries].reverse() as h, i (i)}
                <div class="history-item">
                  <div class="history-meta">
                    <div class="avatar avatar-sm" style="background: {avatarColor(h.userId)}">{initialOf(h.username)}</div>
                    <span class="history-user">{h.username}</span>
                    <span class="history-field">{FIELD_LABELS[h.field] ?? h.field}</span>
                    <span class="history-time">{formatHistoryTime(h.timestamp)}</span>
                  </div>
                  <div class="history-diff">
                    <div class="diff-old"><span class="diff-label">旧</span><span class="diff-text">{h.oldValue || '(空)'}</span></div>
                    <div class="diff-arrow">→</div>
                    <div class="diff-new"><span class="diff-label">新</span><span class="diff-text">{h.newValue || '(空)'}</span></div>
                  </div>
                </div>
              {/each}
            {/if}
          </div>
        </div>
      </div>
    {/if}

    {#if editingId}
      <div class="edit-hint">
        <span>Enter=保存 · Esc=取消 · Ctrl+Enter=保存</span>
      </div>
    {/if}
  </div>
</div>

<style>
  .editor-layout {
    display: grid;
    /* 默认（缩小态）：视频区 40%，编辑区 60% */
    grid-template-columns: 40% 1fr;
    gap: 12px;
    height: calc(100vh - 60px);
    padding: 12px;
    background: #f5f7fa;
    transition: grid-template-columns 0.25s ease;
  }
  /* 放大态：视频区 60%，编辑区 40% */
  .editor-layout.video-expanded {
    grid-template-columns: 60% 1fr;
  }
  .left-panel { display: flex; flex-direction: column; gap: 12px; overflow: hidden; min-width: 0; }
  .right-panel {
    display: flex; flex-direction: column;
    background: #ffffff;
    border: 1px solid #e1e4e8;
    border-radius: 8px;
    overflow: hidden;
    min-width: 0;
  }
  /* 上传进度条 */
  .upload-progress-bar {
    display: flex; align-items: center; gap: 8px;
    padding: 4px 0;
  }
  .progress-track {
    flex: 1; height: 8px; background: #e1e4e8; border-radius: 4px; overflow: hidden;
  }
  .progress-fill {
    height: 100%; background: linear-gradient(90deg, #0969da, #1a7f37);
    transition: width 0.2s ease;
  }
  .progress-pct { font-size: 12px; color: #57606a; min-width: 36px; text-align: right; }
  .toolbar {
    display: flex; justify-content: space-between; align-items: center;
    padding: 8px 12px;
    border-bottom: 1px solid #e1e4e8;
    background: #f6f8fa;
    flex-wrap: wrap; gap: 4px;
  }
  .view-filter { display: flex; gap: 4px; align-items: center; }
  .view-filter button {
    padding: 4px 12px; border: 1px solid #d0d7de;
    background: #ffffff; color: #57606a;
    border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 500;
  }
  .view-filter button.active { background: #0969da; color: white; border-color: #0969da; }
  .btn-range {
    padding: 4px 10px; border: 1px dashed #d29922;
    background: #fff8c5; color: #57606a;
    border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: 500;
  }
  .btn-range.active { background: #d29922; color: white; border-style: solid; }
  .btn-range:hover { background: #ffeec0; }
  .btn-range.active:hover { background: #b8881a; }
  .btn-expand {
    padding: 4px 10px; border: 1px solid #0969da;
    background: #ddf4ff; color: #0969da;
    border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: 500;
  }
  .btn-expand:hover { background: #b6e3ff; }
  .toolbar-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .btn {
    padding: 4px 10px; border-radius: 4px; cursor: pointer;
    font-size: 12px; font-weight: 500; color: white; border: none;
  }
  .btn-primary { background: #0969da; }
  .btn-primary:hover:not(:disabled) { background: #0860c7; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-cancel { background: #e1e4e8; color: #57606a; }
  .btn-cancel:hover { background: #d0d7de; }
  .btn-import { background: #0969da; }
  .btn-import:hover { background: #0860c7; }
  .btn-video { background: #1a7f37; }
  .btn-video:hover { background: #16863d; }
  .btn-video.disabled { opacity: 0.6; cursor: not-allowed; }
  .btn-save-all { background: #cf222e; }
  .upload-status {
    padding: 6px 12px; background: #ddf4ff; color: #0969da;
    font-size: 12px; border-bottom: 1px solid #e1e4e8;
  }
  .save-bar {
    display: flex; align-items: center; gap: 12px;
    padding: 6px 12px; border-bottom: 1px solid #e1e4e8;
    font-size: 12px; color: #57606a;
  }
  .toggle { display: flex; align-items: center; gap: 4px; cursor: pointer; }
  .online-count { margin-left: auto; color: #8c959f; }
  .checked-count { color: #0969da; font-weight: 500; }
  /* 在线用户头像 */
  .online-users {
    display: flex; gap: 6px; padding: 6px 12px; flex-wrap: wrap;
    border-bottom: 1px solid #e1e4e8; align-items: center;
  }
  .avatar {
    width: 26px; height: 26px; border-radius: 50%;
    display: inline-flex; align-items: center; justify-content: center;
    color: white; font-size: 12px; font-weight: 600;
    box-shadow: 0 0 0 2px #ffffff;
    flex-shrink: 0;
  }
  .avatar-sm { width: 22px; height: 22px; font-size: 11px; }
  .avatar-tiny { width: 16px; height: 16px; font-size: 9px; box-shadow: none; }
  .user-chip { padding: 1px 6px; border-radius: 3px; font-size: 11px; color: white; }
  .table-wrap { flex: 1; overflow: auto; }
  .subtitle-table {
    width: 100%; border-collapse: collapse; font-size: 12px;
  }
  .subtitle-table thead {
    position: sticky; top: 0; z-index: 1; background: #f6f8fa;
  }
  .subtitle-table th {
    padding: 6px 8px; text-align: left; font-weight: 600;
    color: #57606a; border-bottom: 1px solid #d0d7de;
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;
  }
  .subtitle-table td {
    padding: 6px 8px; border-bottom: 1px solid #eef0f2;
    vertical-align: top; color: #1a1a2e;
  }
  .col-check { width: 32px; text-align: center; }
  .col-check input[type="checkbox"] { cursor: pointer; }
  .row {
    cursor: pointer; border-left: 3px solid var(--status-color, transparent);
    transition: background 0.1s;
  }
  .row:hover { background: #f6f8fa; }
  .row.selected { background: #ddf4ff; }
  .row.checked { background: #e6f4ff; }
  .row.checked.selected { background: #d1ecff; }
  .row.range-boundary { box-shadow: inset 3px 0 0 #d29922; background: #fffbea; }
  .row.range-boundary:hover { background: #fff5d0; }
  .row.active { box-shadow: inset 3px 0 0 #0969da; }
  .row.readonly .text-cell { color: #57606a; }
  /* 阶段5-2：他人正在编辑此行 —— 左侧光标色边条 + 浅底 */
  .row.being-edited {
    box-shadow: inset 3px 0 0 var(--cursor-color, #d29922);
    background: color-mix(in srgb, var(--cursor-color, #d29922) 8%, transparent);
  }
  .row.being-edited:hover { background: color-mix(in srgb, var(--cursor-color, #d29922) 14%, transparent); }
  .cursor-avatar {
    width: 18px; height: 18px; border-radius: 50%;
    color: white; font-size: 10px; font-weight: 600;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 0 0 2px white, 0 0 0 3px var(--cursor-color, #d29922);
    animation: cursor-pulse 1.4s ease-in-out infinite;
  }
  @keyframes cursor-pulse {
    0%, 100% { box-shadow: 0 0 0 2px white, 0 0 0 3px var(--cursor-color, #d29922); }
    50%      { box-shadow: 0 0 0 2px white, 0 0 0 5px color-mix(in srgb, var(--cursor-color, #d29922) 40%, transparent); }
  }
  .col-idx { width: 44px; color: #8c959f; text-align: right; }
  .idx-cell { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
  .review-avatars { display: flex; align-items: center; gap: 2px; }
  .review-avatars .more { font-size: 10px; color: #57606a; }
  .col-start, .col-end { width: 72px; font-family: 'SF Mono', Monaco, monospace; color: #0969da; }
  .time-cell { cursor: pointer; }
  .time-cell:hover { text-decoration: underline; }
  .col-type { width: 44px; }
  .col-assignee { width: 60px; color: #57606a; }
  .col-text { min-width: 0; display: flex; align-items: center; gap: 2px; }
  .col-text .text-cell { flex: 1; min-width: 0; }
  .col-status { width: 80px; }
  .layer-badge {
    padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 500;
  }
  .layer-0 { background: #e1e4e8; color: #57606a; }
  .layer-1 { background: #ddf4ff; color: #0969da; }
  .text-cell { line-height: 1.5; word-break: break-word; }
  .text-cell.empty .text-body { color: #8c959f; font-style: italic; }
  .tags-readonly { color: #8c959f; font-family: 'SF Mono', Monaco, monospace; font-size: 11px; }
  .lock-icon { font-size: 11px; margin-left: 4px; }
  /* 阶段5-3：修改追踪 —— 行内「已修改」头像按钮 */
  .edit-history-btn {
    flex-shrink: 0;
    width: 18px; height: 18px; border-radius: 50%;
    border: 1.5px solid var(--editor-color, #d29922);
    background: color-mix(in srgb, var(--editor-color, #d29922) 20%, white);
    color: var(--editor-color, #57606a);
    font-size: 9px; font-weight: 600; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    padding: 0; margin-left: 4px;
    transition: transform 0.1s;
  }
  .edit-history-btn:hover { transform: scale(1.15); }
  /* 修改历史弹窗 */
  .modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .modal-header h3 { font-size: 15px; font-weight: 600; color: #1a1a2e; margin: 0; }
  .history-list { display: flex; flex-direction: column; gap: 8px; max-height: 60vh; overflow-y: auto; }
  .history-item {
    border: 1px solid #d0d7de; border-radius: 6px; padding: 8px 10px;
    background: #fafbfc;
  }
  .history-meta { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; font-size: 11px; }
  .history-user { font-weight: 600; color: #1a1a2e; }
  .history-field { color: white; background: #0969da; padding: 1px 6px; border-radius: 3px; font-size: 10px; }
  .history-time { color: #8c959f; margin-left: auto; }
  .history-diff { display: flex; align-items: stretch; gap: 6px; font-size: 12px; }
  .diff-old, .diff-new { flex: 1; padding: 4px 6px; border-radius: 4px; word-break: break-word; }
  .diff-old { background: #ffebe9; border-left: 3px solid #cf222e; }
  .diff-new { background: #dafbe1; border-left: 3px solid #1a7f37; }
  .diff-old .diff-label { color: #cf222e; font-weight: 600; margin-right: 4px; }
  .diff-new .diff-label { color: #1a7f37; font-weight: 600; margin-right: 4px; }
  .diff-text { color: #1a1a2e; white-space: pre-wrap; }
  .diff-arrow { align-self: center; color: #8c959f; font-size: 14px; }
  .empty-tip { color: #8c959f; font-size: 13px; text-align: center; padding: 20px; }
  .status-badge {
    padding: 1px 6px; border-radius: 3px; font-size: 11px; color: white; font-weight: 500;
  }
  textarea {
    width: 100%; background: #f6f8fa; color: #1a1a2e;
    border: 1px solid #d0d7de; border-radius: 4px; padding: 4px 6px;
    resize: vertical; font-family: inherit; font-size: 12px;
    box-sizing: border-box;
  }
  .col-text textarea { flex: 1; min-width: 0; }
  textarea:focus { outline: none; border-color: #0969da; box-shadow: 0 0 0 2px rgba(9,105,218,0.15); }
  select {
    background: #ffffff; color: #1a1a2e; border: 1px solid #d0d7de;
    border-radius: 3px; font-size: 11px; padding: 2px 4px; width: 100%;
  }
  .empty-row { text-align: center; color: #8c959f; padding: 40px 12px; }
  .edit-hint {
    padding: 4px 12px; background: #fff8c5; color: #57606a;
    font-size: 11px; border-top: 1px solid #e1e4e8;
  }
  /* 内联批注行 */
  .inline-review-row { background: #f6f8fa; }
  .inline-review-row > td { padding: 8px 12px; }
  .inline-review-box {
    display: flex; align-items: flex-start; gap: 8px; margin-bottom: 4px;
  }
  .inline-review-box textarea { flex: 1; }
  .inline-review-list { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
  .inline-comment {
    display: flex; gap: 6px; align-items: flex-start;
    padding: 4px 6px; background: #ffffff; border-radius: 4px; border: 1px solid #e1e4e8;
  }
  .comment-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .comment-author { font-weight: 600; color: #0969da; font-size: 11px; }
  .comment-content { color: #1a1a2e; font-size: 12px; word-break: break-word; }
  /* 范围弹窗 */
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.4);
    display: flex; align-items: center; justify-content: center; z-index: 1000;
  }
  .modal-box {
    background: white; border-radius: 8px; padding: 20px;
    min-width: 360px; max-width: 480px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.2);
  }
  .modal-box.modal-wide { max-width: 90vw; max-height: 85vh; overflow: auto; }
  .modal-title { font-size: 16px; font-weight: 600; color: #1a1a2e; margin-bottom: 8px; }
  .modal-desc { font-size: 12px; color: #57606a; margin-bottom: 16px; line-height: 1.5; }
  .modal-desc .hint { color: #8c959f; font-size: 11px; }
  .modal-form { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
  .modal-form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #57606a; flex: 1; }
  .modal-form input {
    padding: 6px 8px; border: 1px solid #d0d7de; border-radius: 4px;
    font-size: 14px;
  }
  .modal-form select {
    padding: 6px 8px; border: 1px solid #d0d7de; border-radius: 4px;
    font-size: 14px; background: white;
  }
  .range-sep { color: #8c959f; padding-top: 20px; }
  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
  /* 导入确认表格 */
  .import-table-wrap {
    max-height: 50vh; overflow: auto; margin-bottom: 16px;
    border: 1px solid #e1e4e8; border-radius: 4px;
  }
  .import-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .import-table th { background: #f6f8fa; padding: 6px 8px; text-align: left; border-bottom: 1px solid #e1e4e8; font-weight: 600; color: #57606a; position: sticky; top: 0; }
  .import-table td { padding: 4px 8px; border-bottom: 1px solid #f0f0f0; vertical-align: middle; }
  .import-table .cell-style { color: #0969da; font-family: monospace; max-width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .import-table .cell-name { color: #57606a; max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .import-table .cell-text { color: #1a1a2e; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .import-table select { padding: 2px 4px; font-size: 11px; border: 1px solid #d0d7de; border-radius: 3px; }
  /* 成员管理 */
  .members-add-row { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; }
  .members-add-row input { flex: 1; padding: 6px 8px; border: 1px solid #d0d7de; border-radius: 4px; font-size: 13px; }
  .members-add-row select { padding: 6px 8px; border: 1px solid #d0d7de; border-radius: 4px; font-size: 13px; background: white; }
  .member-op-msg { padding: 6px 10px; margin-bottom: 10px; background: #ddf4ff; color: #0969da; border-radius: 4px; font-size: 12px; }
  .members-table-wrap { max-height: 40vh; overflow: auto; border: 1px solid #e1e4e8; border-radius: 4px; margin-bottom: 16px; }
  .members-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .members-table th { background: #f6f8fa; padding: 8px; text-align: left; border-bottom: 1px solid #e1e4e8; font-weight: 600; color: #57606a; position: sticky; top: 0; }
  .members-table td { padding: 8px; border-bottom: 1px solid #f0f0f0; }
  .members-table select { padding: 4px 6px; border: 1px solid #d0d7de; border-radius: 3px; font-size: 12px; background: white; }
  .member-cell { display: flex; align-items: center; gap: 6px; }
  .me-tag { background: #0969da; color: white; padding: 1px 4px; border-radius: 3px; font-size: 10px; }
  .role-badge { padding: 2px 6px; border-radius: 3px; font-size: 11px; }
  .role-badge.role-owner { background: #cf222e; color: white; }
  .btn-danger-sm { background: #cf222e; color: white; border: none; padding: 4px 8px; border-radius: 3px; font-size: 11px; cursor: pointer; }
  .btn-danger-sm:hover { background: #a40e26; }
  .hint { color: #8c959f; font-size: 11px; }
  /* 拖选切换按钮 */
  .btn-drag-toggle {
    align-self: flex-start;
    background: #fff8c5; color: #7d4e00; border: 1px solid #d4a72c;
    padding: 4px 10px; font-size: 11px; font-weight: 500; border-radius: 4px;
    cursor: pointer;
  }
  .btn-drag-toggle:hover { background: #fae17d; }
  .btn-drag-toggle.active { background: #d4a72c; color: white; }
  /* 按负责人筛选下拉 */
  .filter-by-assignee { display: inline-flex; align-items: center; gap: 4px; }
  .filter-by-assignee select { padding: 2px 6px; font-size: 11px; border: 1px solid #d0d7de; border-radius: 3px; background: white; }
  .btn-tool {
    background: #f6f8fa; color: #57606a; border: 1px solid #d0d7de;
    padding: 4px 8px; font-size: 11px; font-weight: 500;
  }
  .btn-tool:hover { background: #e1e4e8; }
  .btn-tool.active { background: #0969da; color: white; border-color: #0969da; }
  .btn-tool:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-rehearsal {
    background: #1a7f37; color: white; border: none;
    padding: 4px 10px; font-size: 11px; font-weight: 500;
  }
  .btn-rehearsal:hover { background: #16863d; }
  .btn-rehearsal.active { background: #0a4f23; }
  .panel-overlay {
    position: relative;
    border-bottom: 1px solid #d0d7de;
    background: #ffffff;
    max-height: 360px;
    overflow: auto;
    padding: 12px;
  }
  .panel-close {
    position: absolute; top: 8px; right: 12px;
    background: none; border: none; font-size: 18px;
    color: #8c959f; cursor: pointer; line-height: 1;
  }
  .panel-close:hover { color: #cf222e; }
</style>

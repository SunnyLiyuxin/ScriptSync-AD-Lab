<script lang="ts">
  /**
   * 口述卡片组件
   * 单条字幕的编辑单元：时间、文本、状态、批注、AI建议
   * - 标签与正文分离展示（防止误删 {\pos} 等）
   * - 段落锁（被他人编辑时显示锁定状态）
   * - 状态机流转按钮
   */
  import { createEventDispatcher } from 'svelte';
  import { parseInlineTags, stripAllTags } from '../lib/ass/tag-parser';
  import { formatDisplayTime, secondsToAssTime } from '../lib/ass/time-utils';
  import type { AssEvent, EventStatus, ReviewComment } from '../types/ass';

  interface Props {
    event: AssEvent;
    isActive: boolean;
    lockedByOther: string | null;  // 被他人锁定的用户名
    onlineUsers: { userId: string; username: string; color: string }[];
    comments: ReviewComment[];
  }

  let { event, isActive, lockedByOther, onlineUsers, comments }: Props = $props();

  const dispatch = createEventDispatcher<{
    edit: { id: string; text: string };
    timeUpdate: { id: string; start: number; end: number };
    statusChange: { id: string; status: EventStatus };
    lock: string;
    unlock: string;
    seek: number;
    addComment: { id: string; content: string };
  }>();

  // 解析内联标签
  let parsed = $derived(parseInlineTags(event.text));
  let editingText = $state('');
  let isEditing = $state(false);
  let showComments = $state(false);
  let newComment = $state('');

  const STATUS_LABELS: Record<EventStatus, string> = {
    empty: '空白',
    draft: '初稿',
    peer_review: '审阅中',
    revision_needed: '需修改',
    approved: '已通过',
    locked: '已锁定',
    deleted: '已删除',
  };

  const STATUS_COLORS: Record<EventStatus, string> = {
    empty: '#8c959f',
    draft: '#0969da',
    peer_review: '#d29922',
    revision_needed: '#cf222e',
    approved: '#1a7f37',
    locked: '#57606a',
    deleted: '#8c959f',
  };

  function startEdit() {
    editingText = parsed.cleanText;
    isEditing = true;
    dispatch('lock', event.id);
  }

  function saveEdit() {
    // 合并标签与新文本
    const newText = parsed.tags.length > 0
      ? parsed.tags.join('') + editingText
      : editingText;
    dispatch('edit', { id: event.id, text: newText });
    isEditing = false;
    dispatch('unlock', event.id);
  }

  function cancelEdit() {
    isEditing = false;
    dispatch('unlock', event.id);
  }

  function submitComment() {
    if (!newComment.trim()) return;
    dispatch('addComment', { id: event.id, content: newComment });
    newComment = '';
  }
</script>

<div
  class="event-card"
  class:active={isActive}
  class:locked={lockedByOther !== null}
  style="--status-color: {STATUS_COLORS[event._status]}"
>
  <div class="card-header">
    <span class="time" on:click={() => dispatch('seek', event.start)}>
      {formatDisplayTime(event.start)} → {formatDisplayTime(event.end)}
    </span>
    <span class="layer-badge layer-{event.layer}">
      {event.layer === 0 ? '对白' : '口述'}
    </span>
    <span class="status-badge">{STATUS_LABELS[event._status]}</span>
    {#if lockedByOther}
      <span class="lock-indicator">🔒 {lockedByOther} 编辑中</span>
    {/if}
    {#if event._assignedTo}
        <span class="assignee">
          @{onlineUsers.find(u => u.userId === event._assignedTo)?.username || event._assignedTo}
        </span>
      {/if}
    {#if comments.length > 0}
      <span class="comment-count" on:click={() => showComments = !showComments}>
        💬 {comments.length}
      </span>
    {/if}
  </div>

  <div class="card-body">
    {#if isEditing}
      <textarea bind:value={editingText} rows="3" placeholder="输入口述文本..."></textarea>
      <div class="edit-actions">
        <button class="btn-save" on:click={saveEdit}>保存</button>
        <button class="btn-cancel" on:click={cancelEdit}>取消</button>
      </div>
    {:else}
      <div class="text-content" on:dblclick={startEdit}>
        {#if parsed.tags.length > 0}
          <span class="tags-readonly">{parsed.tags.join('')}</span>
        {/if}
        <span class="text-body">{parsed.cleanText || '(空)'}</span>
      </div>
      {#if !parsed.cleanText}
        <button class="btn-edit" on:click={startEdit}>撰写口述</button>
      {/if}
    {/if}
  </div>

  {#if showComments && comments.length > 0}
    <div class="comments-section">
      {#each comments as c}
        <div class="comment" class:resolved={c.resolved}>
          <strong>{c.authorName}:</strong> {c.content}
        </div>
      {/each}
      <div class="comment-input">
        <input bind:value={newComment} placeholder="添加批注..." on:keydown={(e) => e.key === 'Enter' && submitComment()} />
        <button on:click={submitComment}>发送</button>
      </div>
    </div>
  {/if}

  <div class="card-footer">
    <select
      value={event._status}
      on:change={(e) => dispatch('statusChange', { id: event.id, status: e.currentTarget.value as EventStatus })}
      disabled={lockedByOther !== null}
    >
      {#each Object.entries(STATUS_LABELS) as [value, label]}
        <option value={value}>{label}</option>
      {/each}
    </select>
    <span class="word-count">{stripAllTags(event.text).length} 字</span>
  </div>
</div>

<style>
  .event-card {
    border-left: 3px solid var(--status-color, #8c959f);
    background: #ffffff;
    border: 1px solid #e1e4e8;
    border-left-width: 3px;
    border-radius: 6px;
    padding: 10px 12px;
    margin-bottom: 8px;
    transition: all 0.15s;
  }
  .event-card.active {
    box-shadow: 0 0 0 2px #0969da;
    border-color: #0969da;
  }
  .event-card.locked {
    opacity: 0.65;
    background: #f6f8fa;
  }
  .card-header {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: #57606a;
    margin-bottom: 6px;
    flex-wrap: wrap;
  }
  .time {
    font-family: 'SF Mono', Monaco, monospace;
    cursor: pointer;
    color: #0969da;
  }
  .time:hover { text-decoration: underline; }
  .layer-badge, .status-badge {
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 11px;
    font-weight: 500;
  }
  .layer-0 { background: #e1e4e8; color: #57606a; }
  .layer-1 { background: #ddf4ff; color: #0969da; }
  .status-badge { background: var(--status-color); color: white; }
  .lock-indicator { color: #cf222e; font-size: 11px; }
  .assignee { color: #d29922; font-size: 11px; }
  .comment-count { cursor: pointer; }
  .text-content {
    min-height: 24px;
    cursor: text;
    line-height: 1.5;
    color: #1a1a2e;
  }
  .tags-readonly {
    color: #8c959f;
    font-family: 'SF Mono', Monaco, monospace;
    font-size: 11px;
  }
  .text-body { color: #1a1a2e; }
  textarea {
    width: 100%;
    background: #f6f8fa;
    color: #1a1a2e;
    border: 1px solid #d0d7de;
    border-radius: 4px;
    padding: 6px;
    resize: vertical;
    font-family: inherit;
    font-size: 13px;
  }
  textarea:focus { outline: none; border-color: #0969da; box-shadow: 0 0 0 2px rgba(9,105,218,0.15); }
  .edit-actions { margin-top: 4px; display: flex; gap: 6px; }
  .btn-save, .btn-cancel, .btn-edit {
    padding: 4px 12px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    transition: opacity 0.15s;
  }
  .btn-save { background: #1a7f37; color: white; }
  .btn-save:hover { background: #16863d; }
  .btn-cancel { background: #e1e4e8; color: #57606a; }
  .btn-cancel:hover { background: #d0d7de; }
  .btn-edit { background: #0969da; color: white; }
  .btn-edit:hover { background: #0860c7; }
  .card-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 6px;
    font-size: 11px;
    color: #57606a;
  }
  .word-count { color: #8c959f; }
  .comments-section {
    margin-top: 8px;
    padding: 8px;
    background: #f6f8fa;
    border: 1px solid #e1e4e8;
    border-radius: 4px;
  }
  .comment { font-size: 12px; margin: 2px 0; color: #1a1a2e; }
  .comment strong { color: #0969da; }
  .comment.resolved { opacity: 0.5; text-decoration: line-through; }
  .comment-input { display: flex; gap: 4px; margin-top: 4px; }
  .comment-input input {
    flex: 1;
    background: #ffffff;
    border: 1px solid #d0d7de;
    color: #1a1a2e;
    padding: 4px 8px;
    border-radius: 3px;
    font-size: 12px;
  }
  .comment-input input:focus { outline: none; border-color: #0969da; }
  select {
    background: #ffffff;
    color: #1a1a2e;
    border: 1px solid #d0d7de;
    border-radius: 3px;
    font-size: 11px;
    padding: 2px 4px;
  }
</style>

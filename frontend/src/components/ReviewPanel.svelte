<script lang="ts">
  /**
   * 批注面板组件（V1.5）
   * 行侧批注气泡：显示 / 添加 / 回复 / 解决 / 删除批注
   * 数据源：Yjs comments Map（按 eventId 索引），支持嵌套回复
   */
  import * as Y from 'yjs';
  import type { WebsocketProvider } from 'y-websocket';
  import {
    addComment,
    addReply,
    resolveComment,
    deleteComment,
    getComments,
  } from '../lib/collaboration/yjs-operations';
  import type { ReviewComment } from '../types/ass';

  interface Props {
    doc: Y.Doc;
    provider: WebsocketProvider;
    eventId: string;
    userId: string;
    username: string;
    canEdit: boolean;
  }

  let { doc, provider, eventId, userId, username, canEdit }: Props = $props();
  // provider 供父组件注入 awareness（当前未使用，保留以匹配组件契约）
  void provider;

  let comments = $state<ReviewComment[]>([]);
  let newCommentText = $state('');
  let collapsed = $state(false);
  let replyToId = $state<string | null>(null);
  let replyText = $state('');
  let error = $state<string | null>(null);

  // 订阅 comments Map 变化（eventId 变化时重新订阅）
  $effect(() => {
    const eid = eventId;
    const commentsMap = doc.getMap('comments');
    const update = () => {
      try {
        comments = getComments(doc, eid);
        error = null;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    };
    commentsMap.observeDeep(update);
    update();
    return () => commentsMap.unobserveDeep(update);
  });

  let unresolvedCount = $derived(comments.filter(c => !c.resolved).length);

  function formatTime(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 60_000) return '刚刚';
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
    return new Date(ts).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }

  function submitComment() {
    if (!newCommentText.trim() || !canEdit) return;
    try {
      addComment(doc, eventId, {
        authorId: userId,
        authorName: username,
        content: newCommentText.trim(),
      });
      newCommentText = '';
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function submitReply(parentId: string) {
    if (!replyText.trim() || !canEdit) return;
    try {
      const id = addReply(doc, eventId, parentId, {
        authorId: userId,
        authorName: username,
        content: replyText.trim(),
      });
      if (id === null) {
        error = '父批注不存在';
        return;
      }
      replyText = '';
      replyToId = null;
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function onResolve(commentId: string) {
    try {
      resolveComment(doc, eventId, commentId);
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function onDelete(commentId: string) {
    if (!confirm('确定删除该批注？')) return;
    try {
      deleteComment(doc, eventId, commentId);
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function toggleReply(parentId: string) {
    replyToId = replyToId === parentId ? null : parentId;
    replyText = '';
  }

  function onCommentKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submitComment();
    }
  }
</script>

<div class="review-panel" class:collapsed>
  <div
    class="header"
    on:click={() => collapsed = !collapsed}
    role="button"
    tabindex="0"
    on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); collapsed = !collapsed; } }}
  >
    <span class="title">批注</span>
    {#if unresolvedCount > 0}
      <span class="badge">{unresolvedCount}</span>
    {/if}
    <span class="toggle">{collapsed ? '◀' : '▶'}</span>
  </div>

  {#if !collapsed}
    <div class="body">
      {#if error}
        <div class="error">{error}</div>
      {/if}

      {#if comments.length === 0}
        <div class="empty">暂无批注</div>
      {:else}
        {#each comments as c (c.id)}
          <div class="comment" class:resolved={c.resolved}>
            <div class="comment-head">
              <span class="author">{c.authorName}</span>
              <span class="time">{formatTime(c.createdAt)}</span>
              {#if c.resolved}
                <span class="resolved-tag">已解决</span>
              {/if}
            </div>
            <div class="content">{c.content}</div>
            <div class="actions">
              {#if canEdit && !c.resolved}
                <button class="btn-link" on:click={() => onResolve(c.id)}>解决</button>
              {/if}
              {#if canEdit}
                <button class="btn-link" on:click={() => toggleReply(c.id)}>
                  {replyToId === c.id ? '取消回复' : '回复'}
                </button>
                <button class="btn-link danger" on:click={() => onDelete(c.id)}>删除</button>
              {/if}
            </div>

            {#if replyToId === c.id}
              <div class="reply-box">
                <textarea
                  bind:value={replyText}
                  placeholder="回复 @{c.authorName}..."
                  rows="2"
                ></textarea>
                <button class="btn-primary" on:click={() => submitReply(c.id)} disabled={!replyText.trim()}>
                  回复
                </button>
              </div>
            {/if}

            {#if c.replies && c.replies.length > 0}
              <div class="replies">
                {#each c.replies as r (r.id)}
                  <div class="reply">
                    <div class="comment-head">
                      <span class="author">{r.authorName}</span>
                      <span class="time">{formatTime(r.createdAt)}</span>
                    </div>
                    <div class="content">{r.content}</div>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      {/if}

      {#if canEdit}
        <div class="add-box">
          <textarea
            bind:value={newCommentText}
            placeholder="添加批注... (Ctrl+Enter 提交)"
            rows="2"
            on:keydown={onCommentKeydown}
          ></textarea>
          <button class="btn-primary" on:click={submitComment} disabled={!newCommentText.trim()}>
            提交
          </button>
        </div>
      {:else}
        <div class="readonly-hint">只读模式（无编辑权限）</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .review-panel {
    width: 280px;
    background: #ffffff;
    border: 1px solid #e1e4e8;
    border-radius: 8px;
    font-size: 12px;
    color: #1a1a2e;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
    display: flex;
    flex-direction: column;
  }
  .review-panel.collapsed { width: 36px; }
  .header {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 10px; cursor: pointer;
    border-bottom: 1px solid #e1e4e8;
    background: #f6f8fa; border-radius: 8px 8px 0 0;
    user-select: none;
  }
  .collapsed .header { border-bottom: none; padding: 8px 4px; justify-content: center; }
  .title { font-weight: 600; color: #1a1a2e; }
  .badge {
    background: #cf222e; color: white;
    padding: 0 6px; border-radius: 10px; font-size: 11px;
    min-width: 18px; text-align: center; line-height: 16px;
  }
  .toggle { margin-left: auto; color: #57606a; }
  .collapsed .toggle { margin: 0; }
  .body { padding: 8px; max-height: 60vh; overflow-y: auto; }
  .empty { color: #8c959f; text-align: center; padding: 16px 0; }
  .error {
    background: #ffebe9; color: #cf222e;
    padding: 6px 8px; border-radius: 4px; margin-bottom: 8px;
    border: 1px solid #ffcecb;
  }
  .comment {
    padding: 8px; border: 1px solid #eef0f2;
    border-radius: 6px; margin-bottom: 6px;
    background: #ffffff;
  }
  .comment.resolved { opacity: 0.6; background: #f6f8fa; }
  .comment-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .author { font-weight: 600; color: #0969da; }
  .time { color: #8c959f; font-size: 11px; margin-left: auto; }
  .resolved-tag {
    background: #dafbe1; color: #1a7f37;
    padding: 0 6px; border-radius: 3px; font-size: 10px;
  }
  .content { color: #1a1a2e; line-height: 1.5; word-break: break-word; }
  .actions { display: flex; gap: 8px; margin-top: 4px; }
  .btn-link {
    background: none; border: none; color: #0969da;
    cursor: pointer; font-size: 11px; padding: 2px 0;
  }
  .btn-link:hover { text-decoration: underline; }
  .btn-link.danger { color: #cf222e; }
  .reply-box { margin-top: 6px; display: flex; flex-direction: column; gap: 4px; }
  .replies {
    margin-top: 6px; padding-left: 10px;
    border-left: 2px solid #e1e4e8;
    display: flex; flex-direction: column; gap: 4px;
  }
  .reply { padding: 2px 0; }
  .add-box { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
  textarea {
    width: 100%; background: #f6f8fa; color: #1a1a2e;
    border: 1px solid #d0d7de; border-radius: 4px; padding: 6px 8px;
    resize: vertical; font-family: inherit; font-size: 12px;
    box-sizing: border-box;
  }
  textarea:focus { outline: none; border-color: #0969da; box-shadow: 0 0 0 2px rgba(9, 105, 218, 0.15); }
  .btn-primary {
    background: #0969da; color: white; border: none;
    border-radius: 4px; padding: 5px 10px; cursor: pointer;
    font-size: 12px; font-weight: 500;
  }
  .btn-primary:hover:not(:disabled) { background: #0860c7; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .readonly-hint {
    color: #8c959f; font-size: 11px; text-align: center;
    padding: 8px 0; border-top: 1px solid #eef0f2; margin-top: 6px;
  }
</style>

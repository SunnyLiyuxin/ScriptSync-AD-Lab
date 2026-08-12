<script lang="ts">
  /**
   * 版本历史组件（V1.5）
   * - 显示最近修改列表（来自 Yjs editHistory，谁在何时改了哪条的哪个字段）
   * - 查看历史版本列表：GET /api/projects/{projectId}/versions
   * - 查看某版本内容：GET /api/projects/{projectId}/versions/{versionId}
   * - 回滚到指定版本（二次确认）：POST /api/projects/{projectId}/versions/{versionId}/rollback
   */
  import { onMount, onDestroy } from 'svelte';
  import * as Y from 'yjs';
  import {
    getAllRecentEdits,
    type EditHistoryEntryWithEvent,
  } from '../lib/collaboration/edit-history';
  import type { VersionSnapshot } from '../types/project';

  interface Props {
    doc: Y.Doc;
    projectId: string;
    authToken: string;
  }

  let { doc, projectId, authToken }: Props = $props();

  let recentEdits = $state<EditHistoryEntryWithEvent[]>([]);
  let versions = $state<VersionSnapshot[]>([]);
  let selectedVersion = $state<VersionSnapshot | null>(null);
  let versionContent = $state<string>('');
  let loadingVersions = $state(false);
  let loadingContent = $state(false);
  let rollingBack = $state(false);
  let rollbackVersionId = $state<string | null>(null);
  let error = $state<string | null>(null);

  // 订阅 editHistory Map，最近修改实时刷新
  function observeEditHistory() {
    const editHistory = doc.getMap('editHistory');
    const update = () => {
      try {
        recentEdits = getAllRecentEdits(doc, 100);
        error = null;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    };
    editHistory.observeDeep(update);
    update();
    return () => editHistory.unobserveDeep(update);
  }
  let unobserve: (() => void) | null = null;
  onMount(() => {
    unobserve = observeEditHistory();
    void loadVersions();
  });
  onDestroy(() => { unobserve?.(); });

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }

  function fieldLabel(field: string): string {
    const map: Record<string, string> = {
      text: '文本', start: '开始时间', end: '结束时间', status: '状态',
    };
    return map[field] ?? field;
  }

  function truncate(s: string, max: number = 40): string {
    if (s.length <= max) return s;
    return s.slice(0, max) + '...';
  }

  async function loadVersions() {
    loadingVersions = true;
    error = null;
    try {
      const res = await fetch(`/api/projects/${projectId}/versions`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) throw new Error(`加载版本失败: ${res.status}`);
      const data = await res.json();
      versions = Array.isArray(data)
        ? (data as VersionSnapshot[])
        : ((data?.versions ?? []) as VersionSnapshot[]);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loadingVersions = false;
    }
  }

  async function loadVersionContent(v: VersionSnapshot) {
    selectedVersion = v;
    loadingContent = true;
    versionContent = '';
    error = null;
    try {
      const res = await fetch(`/api/projects/${projectId}/versions/${v.id}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) throw new Error(`加载版本内容失败: ${res.status}`);
      const data = await res.json();
      versionContent = typeof data === 'string'
        ? data
        : (data?.content ?? JSON.stringify(data, null, 2));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loadingContent = false;
    }
  }

  async function rollback(v: VersionSnapshot) {
    if (!confirm(`确定回滚到版本「${v.label}」？此操作不可撤销。`)) return;
    rollbackVersionId = v.id;
    rollingBack = true;
    error = null;
    try {
      const res = await fetch(`/api/projects/${projectId}/versions/${v.id}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) throw new Error(`回滚失败: ${res.status}`);
      await loadVersions();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      rollingBack = false;
      rollbackVersionId = null;
    }
  }
</script>

<div class="version-history">
  {#if error}
    <div class="error">{error}</div>
  {/if}

  <div class="section">
    <div class="section-head">
      <h3>最近修改</h3>
      <span class="count">{recentEdits.length} 条</span>
    </div>
    <div class="edit-list">
      {#if recentEdits.length === 0}
        <div class="empty">暂无修改记录</div>
      {:else}
        {#each recentEdits as e (e.eventId + '-' + e.timestamp)}
          <div class="edit-item">
            <div class="edit-meta">
              <span class="user">{e.username}</span>
              <span class="field">{fieldLabel(e.field)}</span>
              <span class="time">{formatTime(e.timestamp)}</span>
            </div>
            <div class="edit-diff">
              <span class="old">{truncate(e.oldValue)}</span>
              <span class="arrow">→</span>
              <span class="new">{truncate(e.newValue)}</span>
            </div>
            <div class="edit-event">事件: {e.eventId.slice(0, 8)}</div>
          </div>
        {/each}
      {/if}
    </div>
  </div>

  <div class="section">
    <div class="section-head">
      <h3>历史版本</h3>
      <button class="btn-link" on:click={loadVersions} disabled={loadingVersions}>
        {loadingVersions ? '加载中...' : '刷新'}
      </button>
    </div>
    <div class="version-list">
      {#if versions.length === 0 && !loadingVersions}
        <div class="empty">暂无版本快照</div>
      {:else}
        {#each versions as v (v.id)}
          <div
            class="version-item"
            class:selected={selectedVersion?.id === v.id}
            on:click={() => loadVersionContent(v)}
            role="button"
            tabindex="0"
            on:keydown={(e) => { if (e.key === 'Enter') loadVersionContent(v); }}
          >
            <div class="version-label">{v.label}</div>
            <div class="version-meta">
              <span>{formatTime(v.createdAt)}</span>
              <span>{(v.size / 1024).toFixed(1)} KB</span>
            </div>
            <button
              class="btn-rollback"
              disabled={rollingBack && rollbackVersionId === v.id}
              on:click|stopPropagation={() => rollback(v)}
            >
              {rollingBack && rollbackVersionId === v.id ? '回滚中...' : '回滚到此版本'}
            </button>
          </div>
        {/each}
      {/if}
    </div>
  </div>

  {#if selectedVersion}
    <div class="section">
      <div class="section-head">
        <h3>版本内容: {selectedVersion.label}</h3>
        <button class="btn-link" on:click={() => { selectedVersion = null; versionContent = ''; }}>关闭</button>
      </div>
      <div class="version-content">
        {#if loadingContent}
          <div class="empty">加载中...</div>
        {:else}
          <pre>{versionContent}</pre>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .version-history {
    display: flex; flex-direction: column; gap: 12px;
    padding: 12px; background: #ffffff;
    border: 1px solid #e1e4e8; border-radius: 8px;
    font-size: 12px; color: #1a1a2e; max-height: 80vh; overflow-y: auto;
  }
  .error {
    background: #ffebe9; color: #cf222e; padding: 8px;
    border-radius: 4px; border: 1px solid #ffcecb;
  }
  .section { display: flex; flex-direction: column; gap: 6px; }
  .section-head {
    display: flex; justify-content: space-between; align-items: center;
    border-bottom: 1px solid #eef0f2; padding-bottom: 4px;
  }
  .section-head h3 { margin: 0; font-size: 13px; color: #1a1a2e; }
  .count { color: #8c959f; font-size: 11px; }
  .empty { color: #8c959f; text-align: center; padding: 12px 0; }
  .edit-list, .version-list {
    display: flex; flex-direction: column; gap: 4px;
    max-height: 240px; overflow-y: auto;
  }
  .edit-item {
    padding: 6px 8px; background: #f6f8fa;
    border-radius: 4px; border: 1px solid #eef0f2;
  }
  .edit-meta { display: flex; gap: 6px; align-items: center; margin-bottom: 2px; }
  .user { color: #0969da; font-weight: 600; }
  .field { background: #ddf4ff; color: #0969da; padding: 0 6px; border-radius: 3px; font-size: 10px; }
  .time { color: #8c959f; font-size: 11px; margin-left: auto; }
  .edit-diff {
    display: flex; gap: 4px; align-items: center;
    font-family: 'SF Mono', Monaco, monospace; font-size: 11px;
    flex-wrap: wrap;
  }
  .old { color: #cf222e; text-decoration: line-through; }
  .arrow { color: #8c959f; }
  .new { color: #1a7f37; }
  .edit-event { color: #8c959f; font-size: 10px; margin-top: 2px; }
  .version-item {
    padding: 8px; border: 1px solid #e1e4e8; border-radius: 4px;
    cursor: pointer; background: #ffffff; transition: background 0.1s;
  }
  .version-item:hover { background: #f6f8fa; }
  .version-item.selected { border-color: #0969da; background: #ddf4ff; }
  .version-label { font-weight: 600; color: #1a1a2e; margin-bottom: 2px; }
  .version-meta { display: flex; gap: 8px; color: #8c959f; font-size: 11px; margin-bottom: 4px; }
  .btn-rollback {
    background: #cf222e; color: white; border: none;
    border-radius: 3px; padding: 3px 8px; cursor: pointer;
    font-size: 11px; font-weight: 500; width: 100%;
  }
  .btn-rollback:hover:not(:disabled) { background: #a40e26; }
  .btn-rollback:disabled { opacity: 0.6; cursor: not-allowed; }
  .btn-link {
    background: none; border: none; color: #0969da;
    cursor: pointer; font-size: 11px; padding: 2px 4px;
  }
  .btn-link:hover:not(:disabled) { text-decoration: underline; }
  .btn-link:disabled { opacity: 0.5; cursor: not-allowed; }
  .version-content {
    background: #f6f8fa; border: 1px solid #eef0f2;
    border-radius: 4px; padding: 8px; max-height: 300px; overflow: auto;
  }
  .version-content pre {
    margin: 0; white-space: pre-wrap; word-break: break-word;
    font-family: 'SF Mono', Monaco, monospace; font-size: 11px; color: #1a1a2e;
  }
</style>

<script lang="ts">
  /**
   * AI 衔接检查 UI（V2）
   * - 「检查全文衔接」按钮 → POST /api/ai/continuity { events: [...] }
   * - 后端返回 { issues: [{ event_id_a, event_id_b, issue_type, description, suggestion }] }
   * - 列表展示每条 issue（两个相关条目ID、类型、描述、建议）
   * - 点击 issue 跳转到相关条目（dispatch 'jump' 事件，detail 为 event_id）
   */
  import * as Y from 'yjs';
  import { exportEvents } from '../lib/collaboration/yjs-operations';
  import { stripAllTags } from '../lib/ass/tag-parser';
  import { formatDisplayTime } from '../lib/ass/time-utils';
  import type { ContinuityIssue } from '../types/project';
  import type { AssEvent } from '../types/ass';

  interface Props {
    doc: Y.Doc;
    authToken: string;
    onjump?: (e: { eventId: string }) => void;
  }

  let { doc, authToken, onjump }: Props = $props();

  // Yjs events 变化时 bump 版本号，触发 derived 重算
  let eventsVersion = $state(0);
  $effect(() => {
    const yEvents = doc.getArray('events');
    const bump = () => { eventsVersion++; };
    yEvents.observeDeep(bump);
    return () => yEvents.unobserveDeep(bump);
  });

  // 当前 Yjs 中的所有事件快照（响应式）
  let currentEvents = $derived.by<AssEvent[]>(() => {
    void eventsVersion;
    return exportEvents(doc);
  });

  // ===== 检查状态 =====
  let issues = $state<ContinuityIssue[]>([]);
  let loading = $state(false);
  let errorMsg = $state<string | null>(null);
  let lastCheckedAt = $state<number | null>(null);

  const ISSUE_TYPE_LABELS: Record<ContinuityIssue['issue_type'], string> = {
    reference_ambiguous: '指代不明',
    subject_missing: '主语缺失',
    tone_inconsistent: '语气不一致',
    other: '其他',
  };

  const ISSUE_TYPE_COLORS: Record<ContinuityIssue['issue_type'], string> = {
    reference_ambiguous: '#d29922',
    subject_missing: '#cf222e',
    tone_inconsistent: '#0969da',
    other: '#57606a',
  };

  // ===== 执行检查 =====
  async function runCheck() {
    loading = true;
    errorMsg = null;
    issues = [];
    try {
      const eventsPayload = currentEvents
        .filter(e => e._status !== 'deleted')
        .map(e => ({
          event_id: e.id,
          text: stripAllTags(e.text),
          start: e.start,
          end: e.end,
          name: e.name,
          layer: e.layer,
        }));

      if (eventsPayload.length === 0) {
        errorMsg = '没有可检查的字幕条目';
        return;
      }

      const res = await fetch('/api/ai/continuity', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ events: eventsPayload }),
      });
      if (!res.ok) throw new Error(`检查失败: HTTP ${res.status}`);
      const data: { issues: ContinuityIssue[] } = await res.json();
      issues = Array.isArray(data.issues) ? data.issues : [];
      lastCheckedAt = Date.now();
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  // ===== 条目查找（用于展示预览） =====
  function findEvent(eventId: string): AssEvent | null {
    return currentEvents.find(e => e.id === eventId) ?? null;
  }

  function eventPreview(eventId: string): string {
    const e = findEvent(eventId);
    if (!e) return '(条目不存在)';
    const text = stripAllTags(e.text);
    return text.length > 30 ? text.slice(0, 30) + '…' : (text || '(空)');
  }

  function eventTimeLabel(eventId: string): string {
    const e = findEvent(eventId);
    if (!e) return '';
    return formatDisplayTime(e.start);
  }

  // ===== 跳转 =====
  function jumpTo(eventId: string) {
    onjump?.({ eventId });
  }
</script>

<div class="continuity-check">
  <div class="header">
    <div class="title-row">
      <span class="title">🔗 全文衔接检查</span>
      {#if lastCheckedAt}
        <span class="last-checked">上次检查: {new Date(lastCheckedAt).toLocaleTimeString()}</span>
      {/if}
    </div>
    <div class="desc">检测字幕条目之间的指代、主语、语气等衔接问题</div>
  </div>

  <div class="action-bar">
    <button class="btn-primary" on:click={runCheck} disabled={loading}>
      {loading ? '检查中...' : '检查全文衔接'}
    </button>
    {#if issues.length > 0}
      <span class="result-count">发现 {issues.length} 处衔接问题</span>
    {/if}
  </div>

  {#if errorMsg}
    <div class="error">{errorMsg}</div>
  {/if}

  {#if loading}
    <div class="loading">AI 正在分析全文衔接...</div>
  {:else if issues.length === 0 && lastCheckedAt}
    <div class="ok-msg">✓ 未发现衔接问题</div>
  {:else if issues.length === 0}
    <div class="empty">点击「检查全文衔接」开始分析</div>
  {/if}

  {#if issues.length > 0}
    <div class="issue-list">
      {#each issues as issue, i (i)}
        {@const color = ISSUE_TYPE_COLORS[issue.issue_type] || '#57606a'}
        <div class="issue-card" style="--issue-color: {color}">
          <div class="issue-header">
            <span class="issue-type" style="background: {color}">{ISSUE_TYPE_LABELS[issue.issue_type] || issue.issue_type}</span>
            <span class="issue-index">#{i + 1}</span>
          </div>

          <div class="issue-events">
            <button class="event-chip" on:click={() => jumpTo(issue.event_id_a)} title="点击跳转">
              <span class="event-time">{eventTimeLabel(issue.event_id_a)}</span>
              <span class="event-text">{eventPreview(issue.event_id_a)}</span>
              <span class="event-id">{issue.event_id_a.slice(0, 8)}</span>
            </button>
            <span class="connector">⟷</span>
            <button class="event-chip" on:click={() => jumpTo(issue.event_id_b)} title="点击跳转">
              <span class="event-time">{eventTimeLabel(issue.event_id_b)}</span>
              <span class="event-text">{eventPreview(issue.event_id_b)}</span>
              <span class="event-id">{issue.event_id_b.slice(0, 8)}</span>
            </button>
          </div>

          <div class="issue-detail">
            <div class="detail-row">
              <span class="detail-label">问题描述</span>
              <span class="detail-text">{issue.description}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">修改建议</span>
              <span class="detail-text suggestion">{issue.suggestion}</span>
            </div>
          </div>

          <div class="issue-actions">
            <button class="btn-link" on:click={() => jumpTo(issue.event_id_a)}>跳转到条目 A</button>
            <button class="btn-link" on:click={() => jumpTo(issue.event_id_b)}>跳转到条目 B</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .continuity-check {
    display: flex;
    flex-direction: column;
    background: #ffffff;
    border: 1px solid #e1e4e8;
    border-radius: 8px;
    overflow: hidden;
    color: #1a1a2e;
    font-size: 12px;
  }
  .header {
    padding: 10px 12px;
    border-bottom: 1px solid #e1e4e8;
    background: #f6f8fa;
  }
  .title-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .title { font-size: 13px; font-weight: 600; color: #1a1a2e; }
  .last-checked { font-size: 11px; color: #8c959f; }
  .desc { font-size: 11px; color: #57606a; margin-top: 4px; }

  .action-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-bottom: 1px solid #eef0f2;
  }
  .btn-primary {
    background: #0969da;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 5px 12px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
  }
  .btn-primary:hover:not(:disabled) { background: #0860c7; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .result-count { font-size: 11px; color: #cf222e; font-weight: 500; }

  .error {
    background: #ffebe9;
    color: #cf222e;
    padding: 8px 12px;
    border-bottom: 1px solid #ffcecb;
  }
  .loading {
    padding: 24px 12px;
    text-align: center;
    color: #0969da;
  }
  .ok-msg {
    background: #dafbe1;
    color: #1a7f37;
    padding: 12px;
    text-align: center;
    font-weight: 500;
  }
  .empty {
    padding: 20px 12px;
    text-align: center;
    color: #8c959f;
  }

  .issue-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    max-height: 60vh;
    overflow-y: auto;
  }
  .issue-card {
    border: 1px solid #e1e4e8;
    border-left: 3px solid var(--issue-color, #57606a);
    border-radius: 4px;
    padding: 8px 10px;
    background: #ffffff;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .issue-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .issue-type {
    color: white;
    padding: 1px 8px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
  }
  .issue-index { font-size: 11px; color: #8c959f; }

  .issue-events {
    display: flex;
    align-items: stretch;
    gap: 6px;
  }
  .event-chip {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 8px;
    background: #f6f8fa;
    border: 1px solid #e1e4e8;
    border-radius: 4px;
    cursor: pointer;
    text-align: left;
    transition: background 0.15s, border-color 0.15s;
  }
  .event-chip:hover {
    background: #ddf4ff;
    border-color: #0969da;
  }
  .event-time {
    font-family: 'SF Mono', Monaco, monospace;
    font-size: 10px;
    color: #0969da;
  }
  .event-text {
    font-size: 12px;
    color: #1a1a2e;
    word-break: break-word;
  }
  .event-id {
    font-size: 10px;
    color: #8c959f;
    font-family: 'SF Mono', Monaco, monospace;
  }
  .connector {
    display: flex;
    align-items: center;
    color: #8c959f;
    font-size: 14px;
  }

  .issue-detail {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .detail-row {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .detail-label {
    font-size: 10px;
    color: #57606a;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .detail-text {
    font-size: 12px;
    color: #1a1a2e;
    line-height: 1.5;
    word-break: break-word;
  }
  .detail-text.suggestion {
    color: #1a7f37;
    background: #dafbe1;
    padding: 4px 6px;
    border-radius: 3px;
  }

  .issue-actions {
    display: flex;
    gap: 12px;
    border-top: 1px solid #eef0f2;
    padding-top: 6px;
  }
  .btn-link {
    background: none;
    border: none;
    color: #0969da;
    cursor: pointer;
    font-size: 11px;
    padding: 2px 4px;
  }
  .btn-link:hover { text-decoration: underline; }
</style>

<script lang="ts">
  /**
   * AI 检测面板（重构版）
   * 仅保留两个检测：
   * 1. 客观中性检测 - 对选中范围内的每行文本做主观词检测与改写（POST /api/ai/neutral-check）
   * 2. 用词一致性 - 对选中范围内的文本做用词一致性检测（POST /api/ai/consistency）
   *
   * 范围优先级（指令第 8 条）：
   *   有勾选行 → 检测勾选行集合
   *   有输入行号范围 → 检测该范围
   *   都没有 → 提示用户选择或输入范围
   */
  import * as Y from 'yjs';
  import type { WebsocketProvider } from 'y-websocket';
  import { exportEvents, updateText } from '../lib/collaboration/yjs-operations';
  import { parseInlineTags, stripAllTags } from '../lib/ass/tag-parser';
  import type { AssEvent } from '../types/ass';
  import type { ConsistencyIssue } from '../types/project';

  interface Props {
    doc: Y.Doc;
    provider: WebsocketProvider;
    selectedEventId: string | null;
    userId: string;
    username: string;
    authToken: string;
    checkedEvents: AssEvent[];   // 父组件传入的勾选行集合
    allEvents: AssEvent[];       // 全表（用于行号范围解析）
  }

  let {
    doc,
    provider,
    selectedEventId,
    userId,
    username,
    authToken,
    checkedEvents,
    allEvents,
  }: Props = $props();
  // provider / username 由父组件注入，保留以匹配组件契约
  void provider;
  void username;

  type Tab = 'neutral' | 'consistency';
  let activeTab = $state<Tab>('neutral');

  // 用于在 Yjs events 变化时触发 derived 重算
  let eventsVersion = $state(0);
  $effect(() => {
    const yEvents = doc.getArray('events');
    const bump = () => { eventsVersion++; };
    yEvents.observeDeep(bump);
    return () => yEvents.unobserveDeep(bump);
  });

  // ===== 范围解析 =====
  // 行号范围输入（1-based，基于 allEvents 全表）
  let rangeStartInput = $state('');
  let rangeEndInput = $state('');
  let rangeError = $state<string | null>(null);

  // 当前生效的检测范围（基于优先级：勾选行 > 行号范围）
  let activeEvents = $derived.by<AssEvent[]>(() => {
    void eventsVersion;
    // 优先级 1：勾选行
    if (checkedEvents.length > 0) return checkedEvents.slice();
    // 优先级 2：行号范围
    const s = parseInt(rangeStartInput, 10);
    const e = parseInt(rangeEndInput, 10);
    if (Number.isFinite(s) && Number.isFinite(e) && s >= 1 && e >= s) {
      const list: AssEvent[] = [];
      for (let i = s - 1; i <= e - 1 && i < allEvents.length; i++) {
        if (i >= 0) list.push(allEvents[i]);
      }
      return list;
    }
    return [];
  });

  // 范围描述（用于 UI 显示）
  let rangeDesc = $derived.by<string>(() => {
    if (checkedEvents.length > 0) return `勾选行 × ${checkedEvents.length}`;
    const s = parseInt(rangeStartInput, 10);
    const e = parseInt(rangeEndInput, 10);
    if (Number.isFinite(s) && Number.isFinite(e) && s >= 1 && e >= s) {
      return `行号 ${s}-${e}（${Math.min(e, allEvents.length) - s + 1} 行）`;
    }
    return '未设定范围';
  });

  // ===== 客观中性检测 =====
  interface SubjectiveSpan { start: number; end: number; word: string }
  interface NeutralCheckResponse {
    original: string;
    subjective_spans: SubjectiveSpan[];
    rewritten: string;
    char_count: { original: number; rewritten: number };
  }
  // 多行检测结果：按 event 分组
  interface NeutralItem {
    eventId: string;
    idx: number;        // 在 activeEvents 中的序号（1-based）
    original: string;
    result: NeutralCheckResponse | null;
    error: string | null;
    loading: boolean;
    editingMode: boolean;
    editedRewritten: string;
  }
  let neutralItems = $state<NeutralItem[]>([]);
  let neutralLoading = $state(false);
  let neutralError = $state<string | null>(null);

  function findEvent(id: string | null): AssEvent | null {
    if (!id) return null;
    const events = exportEvents(doc);
    return events.find(e => e.id === id) ?? null;
  }

  // 客观中性检测：对范围内每行逐条调用（保留 inline tags 信息）
  async function runNeutralCheck() {
    if (activeEvents.length === 0) {
      rangeError = '请先勾选行，或输入起止行号';
      return;
    }
    rangeError = null;
    neutralLoading = true;
    neutralError = null;
    // 初始化 items
    neutralItems = activeEvents.map((e, i) => ({
      eventId: e.id,
      idx: i + 1,
      original: stripAllTags(e.text),
      result: null,
      error: null,
      loading: true,
      editingMode: false,
      editedRewritten: '',
    }));
    try {
      // 并发但限制并发数（避免后端过载）
      const CONCURRENCY = 4;
      let cursor = 0;
      const workers = Array.from({ length: Math.min(CONCURRENCY, neutralItems.length) }, async () => {
        while (cursor < neutralItems.length) {
          const i = cursor++;
          const item = neutralItems[i];
          const e = findEvent(item.eventId);
          if (!e) {
            neutralItems[i] = { ...item, loading: false, error: '行已删除' };
            continue;
          }
          const text = stripAllTags(e.text);
          if (!text) {
            neutralItems[i] = { ...item, loading: false, error: '该行文本为空' };
            continue;
          }
          try {
            const res = await fetch('/api/ai/neutral-check', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${authToken}`,
              },
              body: JSON.stringify({ text }),
            });
            if (!res.ok) throw new Error(`检测失败: ${res.status}`);
            const data: NeutralCheckResponse = await res.json();
            neutralItems[i] = {
              ...item,
              result: data,
              loading: false,
              editedRewritten: data.rewritten,
            };
          } catch (err) {
            neutralItems[i] = {
              ...item,
              loading: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }
      });
      await Promise.all(workers);
    } catch (err) {
      neutralError = err instanceof Error ? err.message : String(err);
    } finally {
      neutralLoading = false;
    }
  }

  // 采纳推荐：替换原文本（保留 inline tags）
  function acceptRewritten(item: NeutralItem) {
    if (!item.result) return;
    const e = findEvent(item.eventId);
    if (!e) return;
    const parsed = parseInlineTags(e.text);
    const newText = parsed.tags.length > 0
      ? parsed.tags.join('') + item.result.rewritten
      : item.result.rewritten;
    const ok = updateText(doc, item.eventId, newText, userId);
    if (!ok) {
      neutralError = '替换失败：无编辑权限';
      return;
    }
    neutralError = null;
    // 标记已采纳（清空 result 视觉提示，或保留显示）
    // 这里保留显示，但加一个 adopted 标记
    const idx = neutralItems.findIndex(n => n.eventId === item.eventId);
    if (idx >= 0) neutralItems[idx] = { ...neutralItems[idx], result: null, editingMode: false };
  }

  // 编辑推荐
  function startEditRewritten(item: NeutralItem) {
    if (!item.result) return;
    const idx = neutralItems.findIndex(n => n.eventId === item.eventId);
    if (idx >= 0) neutralItems[idx] = { ...neutralItems[idx], editingMode: true, editedRewritten: item.result.rewritten };
  }
  function applyEditedRewritten(item: NeutralItem) {
    if (!item.editedRewritten.trim()) return;
    const e = findEvent(item.eventId);
    if (!e) return;
    const parsed = parseInlineTags(e.text);
    const newText = parsed.tags.length > 0
      ? parsed.tags.join('') + item.editedRewritten.trim()
      : item.editedRewritten.trim();
    const ok = updateText(doc, item.eventId, newText, userId);
    if (!ok) {
      neutralError = '替换失败：无编辑权限';
      return;
    }
    neutralError = null;
    const idx = neutralItems.findIndex(n => n.eventId === item.eventId);
    if (idx >= 0) neutralItems[idx] = { ...neutralItems[idx], result: null, editingMode: false };
  }
  function cancelEditRewritten(item: NeutralItem) {
    const idx = neutralItems.findIndex(n => n.eventId === item.eventId);
    if (idx >= 0) neutralItems[idx] = { ...neutralItems[idx], editingMode: false };
  }

  // ===== 用词一致性检测 =====
  let consistencyResult = $state<ConsistencyIssue[]>([]);
  let consistencyLoading = $state(false);
  let consistencyError = $state<string | null>(null);
  let replacedPairs = $state<Set<string>>(new Set());

  async function runConsistencyCheck() {
    if (activeEvents.length === 0) {
      rangeError = '请先勾选行，或输入起止行号';
      return;
    }
    rangeError = null;
    consistencyLoading = true;
    consistencyError = null;
    consistencyResult = [];
    replacedPairs = new Set();
    try {
      const events = activeEvents.map(e => ({
        event_id: e.id,
        text: stripAllTags(e.text),
      }));
      const res = await fetch('/api/ai/consistency', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ events }),
      });
      if (!res.ok) throw new Error(`检测失败: ${res.status}`);
      const data: { inconsistencies: ConsistencyIssue[] } = await res.json();
      consistencyResult = data.inconsistencies ?? [];
    } catch (err) {
      consistencyError = err instanceof Error ? err.message : String(err);
    } finally {
      consistencyLoading = false;
    }
  }

  // 一键替换：用 suggestion 替换所有 occurrence 中的 word_b
  function replaceWord(issue: ConsistencyIssue) {
    const key = `${issue.word_a}|${issue.word_b}`;
    try {
      for (const occ of issue.occurrences) {
        const e = findEvent(occ.event_id);
        if (!e) continue;
        const parsed = parseInlineTags(e.text);
        const cleanText = parsed.cleanText;
        if (!cleanText.includes(issue.word_b)) continue;
        const newClean = cleanText.split(issue.word_b).join(issue.suggestion);
        const newText = parsed.tags.length > 0
          ? parsed.tags.join('') + newClean
          : newClean;
        updateText(doc, occ.event_id, newText, userId);
      }
      replacedPairs = new Set([...replacedPairs, key]);
      consistencyError = null;
    } catch (err) {
      consistencyError = err instanceof Error ? err.message : String(err);
    }
  }

  // 高亮原文中的主观词
  function renderHighlighted(text: string, spans: SubjectiveSpan[]): string {
    if (!spans || spans.length === 0) return escapeHtml(text);
    const sorted = [...spans].sort((a, b) => a.start - b.start);
    let result = '';
    let cursor = 0;
    for (const s of sorted) {
      if (s.start < cursor) continue;
      result += escapeHtml(text.slice(cursor, s.start));
      result += `<mark class="subjective">${escapeHtml(text.slice(s.start, s.end))}</mark>`;
      cursor = s.end;
    }
    result += escapeHtml(text.slice(cursor));
    return result;
  }
  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
</script>

<div class="ai-panel">
  <div class="tabs">
    <button class:active={activeTab === 'neutral'} on:click={() => activeTab = 'neutral'}>客观中性检测</button>
    <button class:active={activeTab === 'consistency'} on:click={() => activeTab = 'consistency'}>用词一致性</button>
  </div>

  <!-- 范围选择条（两个 tab 共用） -->
  <div class="range-bar">
    <div class="range-status">
      <span class="range-label">检测范围:</span>
      <span class="range-value" class:active={activeEvents.length > 0}>{rangeDesc}</span>
    </div>
    {#if checkedEvents.length === 0}
      <div class="range-input">
        <span>或输入行号:</span>
        <input type="number" min="1" bind:value={rangeStartInput} placeholder="起" />
        <span>—</span>
        <input type="number" min="1" bind:value={rangeEndInput} placeholder="止" />
      </div>
    {/if}
    {#if rangeError}
      <div class="range-error">{rangeError}</div>
    {/if}
  </div>

  <div class="tab-body">
    <!-- Tab 1: 客观中性检测 -->
    {#if activeTab === 'neutral'}
      <div class="tab-section">
        <div class="action-bar">
          <button class="btn-primary" on:click={runNeutralCheck} disabled={neutralLoading || activeEvents.length === 0}>
            {neutralLoading ? '检测中...' : `检测 ${activeEvents.length} 行`}
          </button>
          {#if activeEvents.length === 0}
            <span class="hint">请勾选行或输入行号范围</span>
          {/if}
        </div>

        {#if neutralError}
          <div class="error">{neutralError}</div>
        {/if}

        {#if neutralItems.length > 0}
          <div class="neutral-list">
            {#each neutralItems as item (item.eventId)}
              <div class="neutral-item">
                <div class="item-head">
                  <span class="item-idx">#{item.idx}</span>
                  {#if item.loading}
                    <span class="item-loading">检测中...</span>
                  {:else if item.error}
                    <span class="item-error">{item.error}</span>
                  {:else if item.result}
                    {#if item.result.rewritten === ''}
                      <span class="item-ok">✓ 未发现主观内容</span>
                    {:else}
                      <span class="item-warn">⚠ 发现主观内容</span>
                    {/if}
                  {/if}
                </div>
                {#if item.result}
                  {#if item.result.rewritten !== ''}
                    <div class="result-block">
                      <div class="block-title">原文 <span class="char-count">{item.result.char_count.original} 字</span></div>
                      <div class="original-text">{@html renderHighlighted(item.result.original, item.result.subjective_spans)}</div>
                    </div>
                    <div class="result-block">
                      <div class="block-title">改写推荐 <span class="char-count">{item.result.char_count.rewritten} 字</span></div>
                      {#if item.editingMode}
                        <textarea bind:value={neutralItems[neutralItems.findIndex(n => n.eventId === item.eventId)].editedRewritten} rows="3"></textarea>
                        <div class="btn-row">
                          <button class="btn-primary" on:click={() => applyEditedRewritten(item)} disabled={!item.editedRewritten.trim()}>应用</button>
                          <button class="btn-link" on:click={() => cancelEditRewritten(item)}>取消</button>
                        </div>
                      {:else}
                        <div class="rewritten-text">{item.result.rewritten}</div>
                        <div class="btn-row">
                          <button class="btn-primary" on:click={() => acceptRewritten(item)}>采纳</button>
                          <button class="btn-secondary" on:click={() => startEditRewritten(item)}>编辑</button>
                        </div>
                      {/if}
                    </div>
                  {/if}
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>

    {:else if activeTab === 'consistency'}
      <div class="tab-section">
        <div class="action-bar">
          <button class="btn-primary" on:click={runConsistencyCheck} disabled={consistencyLoading || activeEvents.length === 0}>
            {consistencyLoading ? '检测中...' : `检测 ${activeEvents.length} 行`}
          </button>
          {#if activeEvents.length === 0}
            <span class="hint">请勾选行或输入行号范围</span>
          {/if}
        </div>

        {#if consistencyError}
          <div class="error">{consistencyError}</div>
        {/if}

        {#if consistencyResult.length > 0}
          <div class="issue-list">
            {#each consistencyResult as issue, i (i)}
              {@const key = `${issue.word_a}|${issue.word_b}`}
              <div class="issue-item">
                <div class="issue-words">
                  <span class="word-a">{issue.word_a}</span>
                  <span class="vs">vs</span>
                  <span class="word-b">{issue.word_b}</span>
                </div>
                <div class="issue-suggestion">建议: <strong>{issue.suggestion}</strong></div>
                <div class="issue-occurrences">{issue.occurrences.length} 处出现</div>
                <button
                  class="btn-primary small"
                  on:click={() => replaceWord(issue)}
                  disabled={replacedPairs.has(key)}
                >
                  {replacedPairs.has(key) ? '已替换' : '一键替换'}
                </button>
              </div>
            {/each}
          </div>
        {:else if !consistencyLoading}
          <div class="empty">点击「检测」开始</div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .ai-panel {
    display: flex; flex-direction: column;
    background: #ffffff; border: 1px solid #e1e4e8;
    border-radius: 8px; font-size: 12px; color: #1a1a2e;
    overflow: hidden;
  }
  .tabs { display: flex; border-bottom: 1px solid #e1e4e8; background: #f6f8fa; }
  .tabs button {
    flex: 1; padding: 8px 4px; border: none; background: none;
    color: #57606a; cursor: pointer; font-size: 12px; font-weight: 500;
    border-bottom: 2px solid transparent;
  }
  .tabs button:hover { background: #eaeef2; }
  .tabs button.active { color: #0969da; border-bottom-color: #0969da; background: #ffffff; }
  /* 范围条 */
  .range-bar {
    padding: 8px 12px; background: #f6f8fa;
    border-bottom: 1px solid #e1e4e8;
    display: flex; flex-direction: column; gap: 6px;
  }
  .range-status { display: flex; align-items: center; gap: 6px; }
  .range-label { color: #57606a; font-size: 11px; }
  .range-value { color: #8c959f; font-size: 11px; }
  .range-value.active { color: #0969da; font-weight: 600; }
  .range-input { display: flex; align-items: center; gap: 4px; font-size: 11px; color: #57606a; }
  .range-input input {
    width: 50px; padding: 2px 4px; border: 1px solid #d0d7de;
    border-radius: 3px; font-size: 11px;
  }
  .range-error { color: #cf222e; font-size: 11px; }
  .tab-body { padding: 12px; overflow-y: auto; max-height: 70vh; }
  .tab-section { display: flex; flex-direction: column; gap: 10px; }
  .action-bar { display: flex; align-items: center; gap: 8px; }
  .hint { color: #8c959f; font-size: 11px; }
  .btn-primary {
    background: #0969da; color: white; border: none;
    border-radius: 4px; padding: 5px 12px; cursor: pointer;
    font-size: 12px; font-weight: 500;
  }
  .btn-primary:hover:not(:disabled) { background: #0860c7; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary.small { padding: 3px 8px; font-size: 11px; }
  .btn-secondary {
    background: #ffffff; color: #0969da; border: 1px solid #0969da;
    border-radius: 4px; padding: 4px 12px; cursor: pointer;
    font-size: 12px; font-weight: 500;
  }
  .btn-secondary:hover { background: #ddf4ff; }
  .btn-link {
    background: none; border: none; color: #0969da;
    cursor: pointer; font-size: 11px; padding: 2px 4px;
  }
  .btn-link:hover { text-decoration: underline; }
  .error {
    background: #ffebe9; color: #cf222e;
    padding: 6px 8px; border-radius: 4px;
    border: 1px solid #ffcecb;
  }
  .empty { color: #8c959f; text-align: center; padding: 16px 0; }
  .btn-row { display: flex; gap: 8px; margin-top: 4px; }
  /* 客观中性列表 */
  .neutral-list { display: flex; flex-direction: column; gap: 8px; }
  .neutral-item {
    padding: 8px; border: 1px solid #eef0f2; border-radius: 6px;
    background: #ffffff;
  }
  .item-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .item-idx { font-weight: 600; color: #57606a; font-size: 11px; }
  .item-loading { color: #8c959f; font-size: 11px; }
  .item-error { color: #cf222e; font-size: 11px; }
  .item-ok { color: #1a7f37; font-size: 11px; }
  .item-warn { color: #cf222e; font-size: 11px; font-weight: 500; }
  .result-block { margin-top: 6px; }
  .block-title {
    font-size: 11px; color: #57606a; font-weight: 600; margin-bottom: 2px;
  }
  .char-count { color: #8c959f; font-weight: 400; margin-left: 4px; }
  .original-text {
    padding: 4px 6px; background: #f6f8fa; border-radius: 4px;
    line-height: 1.5; word-break: break-word;
  }
  .rewritten-text {
    padding: 4px 6px; background: #ddf4ff; border-radius: 4px;
    color: #0969da; line-height: 1.5; word-break: break-word;
  }
  textarea {
    width: 100%; background: #f6f8fa; color: #1a1a2e;
    border: 1px solid #d0d7de; border-radius: 4px; padding: 4px 6px;
    resize: vertical; font-family: inherit; font-size: 12px;
    box-sizing: border-box;
  }
  textarea:focus { outline: none; border-color: #0969da; box-shadow: 0 0 0 2px rgba(9,105,218,0.15); }
  :global(mark.subjective) {
    background: #fff8c5; color: #1a1a2e; padding: 0 2px; border-radius: 2px;
  }
  /* 一致性问题列表 */
  .issue-list { display: flex; flex-direction: column; gap: 6px; }
  .issue-item {
    padding: 8px; border: 1px solid #eef0f2; border-radius: 6px;
    background: #ffffff;
  }
  .issue-words { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .word-a { background: #dafbe1; color: #1a7f37; padding: 1px 6px; border-radius: 3px; font-weight: 500; }
  .word-b { background: #ffebe9; color: #cf222e; padding: 1px 6px; border-radius: 3px; font-weight: 500; }
  .vs { color: #8c959f; font-size: 10px; }
  .issue-suggestion { font-size: 11px; color: #57606a; margin-bottom: 2px; }
  .issue-occurrences { font-size: 11px; color: #8c959f; margin-bottom: 6px; }
</style>

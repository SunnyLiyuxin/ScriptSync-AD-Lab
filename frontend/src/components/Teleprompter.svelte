<script lang="ts">
  /**
   * 提词器组件（V2）
   * 口述演练时的大字体提词视图，根据 currentTime 实时切换。
   * - 当前条目大号字（36px）居中高亮
   * - 下一条预览小号字（18px）灰色
   * - 切换时平滑滚动/淡入
   * - presenterId === userId 时显示「你正在念稿」
   */
  import { fade, slide } from 'svelte/transition';
  import { parseInlineTags, stripAllTags, assNewlinesToReal } from '../lib/ass/tag-parser';
  import { formatDisplayTime } from '../lib/ass/time-utils';
  import type { AssEvent } from '../types/ass';

  interface Props {
    events: AssEvent[];
    currentTime: number;
    presenterId: string | null;
    userId: string;
  }

  let { events, currentTime, presenterId, userId }: Props = $props();

  /** 过滤并按时间排序的有效条目 */
  let activeEvents = $derived(
    events
      .filter(e => e._status !== 'deleted')
      .slice()
      .sort((a, b) => a.start - b.start),
  );

  interface Cue {
    event: AssEvent;
    index: number;
    text: string;
    isLive: boolean; // 是否正在被念（currentTime 落在其 start/end 区间内）
  }

  /** 当前应显示的条目（含 live 与 upcoming 两种语义） */
  let currentCue = $derived.by<Cue | null>(() => {
    if (activeEvents.length === 0) return null;
    // 1. 找到 currentTime 落在区间内的条目
    const liveIdx = activeEvents.findIndex(e => currentTime >= e.start && currentTime < e.end);
    if (liveIdx >= 0) {
      return { event: activeEvents[liveIdx], index: liveIdx, text: cueText(activeEvents[liveIdx]), isLive: true };
    }
    // 2. 处于间隙：显示下一条 upcoming
    const nextIdx = activeEvents.findIndex(e => e.start > currentTime);
    if (nextIdx >= 0) {
      return { event: activeEvents[nextIdx], index: nextIdx, text: cueText(activeEvents[nextIdx]), isLive: false };
    }
    // 3. 已播完所有条目：显示最后一条
    const last = activeEvents[activeEvents.length - 1];
    return { event: last, index: activeEvents.length - 1, text: cueText(last), isLive: false };
  });

  /** 下一条预览 */
  let nextCue = $derived.by<Cue | null>(() => {
    if (!currentCue) return null;
    const nextIdx = currentCue.index + 1;
    if (nextIdx >= activeEvents.length) return null;
    const e = activeEvents[nextIdx];
    return { event: e, index: nextIdx, text: cueText(e), isLive: false };
  });

  /** 是否为本人在念稿 */
  let isPresenter = $derived(presenterId !== null && presenterId === userId);

  /** 进度百分比（基于当前条目在 active 列表中的位置） */
  let progressPercent = $derived(
    activeEvents.length === 0 || !currentCue
      ? 0
      : Math.round(((currentCue.index + (currentCue.isLive ? 0.5 : 0)) / activeEvents.length) * 100),
  );

  function cueText(e: AssEvent): string {
    const parsed = parseInlineTags(e.text);
    return assNewlinesToReal(parsed.cleanText || stripAllTags(e.text));
  }
</script>

<div class="teleprompter" class:presenter={isPresenter}>
  <!-- 顶部状态条 -->
  <div class="status-bar">
    <div class="status-left">
      {#if isPresenter}
        <span class="presenter-badge">🎙 你正在念稿</span>
      {:else if presenterId}
        <span class="listening-badge">🎧 旁听中</span>
      {:else}
        <span class="idle-badge">提词器待机</span>
      {/if}
    </div>
    <div class="status-right">
      {#if currentCue}
        <span class="cue-index">#{currentCue.index + 1} / {activeEvents.length}</span>
        <span class="cue-time">{formatDisplayTime(currentCue.event.start)}</span>
        {#if !currentCue.isLive}
          <span class="cue-upcoming">即将开始</span>
        {/if}
      {/if}
    </div>
  </div>

  <!-- 主体：当前 + 下一条 -->
  <div class="prompter-body">
    {#if !currentCue}
      <div class="empty" in:fade={{ duration: 200 }}>
        暂无字幕条目
      </div>
    {:else}
      <!-- 当前条目：大号字、居中、淡入 -->
      {#key currentCue.event.id}
        <div class="current-cue" class:live={currentCue.isLive} in:fade={{ duration: 250 }}>
          {#if currentCue.event.name}
            <div class="speaker-name">{currentCue.event.name}</div>
          {/if}
          <div class="cue-text">{currentCue.text || '(空)'}</div>
          <div class="cue-meta">
            <span class="layer-tag layer-{currentCue.event.layer}">
              {currentCue.event.layer === 0 ? '对白' : '口述'}
            </span>
            <span class="duration">
              {formatDisplayTime(currentCue.event.start)} – {formatDisplayTime(currentCue.event.end)}
            </span>
          </div>
        </div>
      {/key}

      <!-- 下一条预览 -->
      <div class="next-cue-wrap">
        {#if nextCue}
          {#key nextCue.event.id}
            <div class="next-cue" in:fade={{ duration: 300, delay: 80 }}>
              <div class="next-label">下一条 ▼</div>
              {#if nextCue.event.name}
                <span class="next-speaker">{nextCue.event.name}：</span>
              {/if}
              <span class="next-text">{nextCue.text || '(空)'}</span>
            </div>
          {/key}
        {:else}
          <div class="next-cue end" in:fade={{ duration: 200 }}>
            <span class="next-label">已是最后一条</span>
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <!-- 进度条 -->
  <div class="progress-bar">
    <div class="progress-fill" style="width: {progressPercent}%"></div>
  </div>
</div>

<style>
  .teleprompter {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: #ffffff;
    border: 1px solid #e1e4e8;
    border-radius: 8px;
    overflow: hidden;
    color: #1a1a2e;
  }
  .teleprompter.presenter {
    border-color: #0969da;
    box-shadow: 0 0 0 2px rgba(9, 105, 218, 0.15);
  }

  /* 状态条 */
  .status-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 14px;
    background: #f6f8fa;
    border-bottom: 1px solid #e1e4e8;
    font-size: 12px;
  }
  .presenter-badge {
    background: #0969da;
    color: #ffffff;
    padding: 3px 10px;
    border-radius: 12px;
    font-weight: 600;
    font-size: 12px;
  }
  .listening-badge {
    background: #fff8c5;
    color: #57606a;
    padding: 3px 10px;
    border-radius: 12px;
    font-weight: 500;
    font-size: 12px;
  }
  .idle-badge {
    color: #8c959f;
    font-size: 12px;
  }
  .status-right {
    display: flex;
    align-items: center;
    gap: 10px;
    color: #57606a;
    font-size: 12px;
  }
  .cue-index { color: #0969da; font-weight: 600; }
  .cue-time { font-family: 'SF Mono', Monaco, monospace; }
  .cue-upcoming {
    background: #ddf4ff;
    color: #0969da;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 11px;
  }

  /* 主体 */
  .prompter-body {
    flex: 1;
    overflow-y: auto;
    padding: 24px 28px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 24px;
  }

  .empty {
    color: #8c959f;
    font-size: 16px;
    text-align: center;
  }

  /* 当前条目 */
  .current-cue {
    width: 100%;
    max-width: 900px;
    text-align: center;
    padding: 18px 12px;
    border-radius: 8px;
    background: #f6f8fa;
    border: 2px solid transparent;
    transition: background 0.2s, border-color 0.2s;
  }
  .current-cue.live {
    background: #ddf4ff;
    border-color: #0969da;
  }
  .speaker-name {
    color: #0969da;
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 8px;
  }
  .cue-text {
    font-size: 36px;
    line-height: 1.5;
    font-weight: 600;
    color: #1a1a2e;
    word-break: break-word;
    white-space: pre-wrap;
  }
  .cue-meta {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 10px;
    margin-top: 14px;
    font-size: 13px;
    color: #57606a;
  }
  .layer-tag {
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 11px;
    font-weight: 500;
  }
  .layer-0 { background: #e1e4e8; color: #57606a; }
  .layer-1 { background: #ddf4ff; color: #0969da; }
  .duration { font-family: 'SF Mono', Monaco, monospace; }

  /* 下一条预览 */
  .next-cue-wrap {
    width: 100%;
    max-width: 900px;
    display: flex;
    justify-content: center;
  }
  .next-cue {
    width: 100%;
    text-align: center;
    padding: 12px 16px;
    color: #8c959f;
    font-size: 18px;
    line-height: 1.5;
    word-break: break-word;
  }
  .next-cue.end {
    font-style: italic;
    color: #8c959f;
  }
  .next-label {
    font-size: 12px;
    color: #8c959f;
    margin-bottom: 4px;
    letter-spacing: 1px;
  }
  .next-speaker {
    color: #57606a;
    font-weight: 500;
    margin-right: 4px;
  }
  .next-text {
    white-space: pre-wrap;
  }

  /* 进度条 */
  .progress-bar {
    height: 4px;
    background: #e1e4e8;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: #0969da;
    transition: width 0.3s ease;
  }
</style>

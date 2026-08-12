<script lang="ts">
  /**
   * 视频播放器组件
   * - 自定义控制条（不用原生 controls，避免右下角全屏按钮与我加的扩展按钮冲突）
   * - 编辑态：各自独立播放，互不影响
   * - 演练态：一人控制，众人跟随（通过 awareness 同步播放状态）
   * 片源由负责人上传云端，所有人从同一 URL 加载，但播放进度独立
   */
  import { createEventDispatcher } from 'svelte';

  interface Props {
    src: string;
    currentTime: number;
    syncMode?: boolean;  // 演练态同步模式
    expanded?: boolean;  // 视频区域是否放大
  }

  let { src, currentTime = $bindable(), syncMode = false, expanded = false }: Props = $props();

  let videoEl: HTMLVideoElement | null = $state(null);
  let isPlaying = $state(false);
  let duration = $state(0);
  let muted = $state(false);
  let showControls = $state(true);
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  const dispatch = createEventDispatcher();

  function onTimeUpdate() {
    if (!videoEl) return;
    currentTime = videoEl.currentTime;
    dispatch('timeUpdate', currentTime);
  }

  function onPlay() {
    isPlaying = true;
    dispatch('playStateChange', { isPlaying: true, currentTime });
  }

  function onPause() {
    isPlaying = false;
    dispatch('playStateChange', { isPlaying: false, currentTime });
  }

  function seek(time: number) {
    if (videoEl) videoEl.currentTime = time;
  }

  function togglePlay() {
    if (!videoEl) return;
    isPlaying ? videoEl.pause() : videoEl.play();
  }

  function toggleMute() {
    if (!videoEl) return;
    muted = !muted;
    videoEl.muted = muted;
  }

  // 进度条交互
  function onProgressClick(e: MouseEvent) {
    if (!videoEl || !duration) return;
    const bar = e.currentTarget as HTMLElement;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seek(ratio * duration);
  }

  // 鼠标移入显示控制条，移出后 1.5s 隐藏
  function onMouseMove() {
    showControls = true;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (isPlaying) showControls = false; }, 1500);
  }
  function onMouseLeave() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (isPlaying) showControls = false; }, 500);
  }

  function fmt(t: number): string {
    if (!Number.isFinite(t) || t < 0) return '0:00';
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  // 快捷键
  function onKeydown(e: KeyboardEvent) {
    if (!videoEl) return;
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        seek(videoEl.currentTime - 2);
        break;
      case 'ArrowRight':
        e.preventDefault();
        seek(videoEl.currentTime + 2);
        break;
    }
  }

  // 暴露方法给父组件
  export function play() { videoEl?.play(); }
  export function pause() { videoEl?.pause(); }
  export function seekTo(t: number) { seek(t); }
  export function getCurrentTime(): number { return videoEl?.currentTime ?? 0; }
  export function getIsPlaying(): boolean { return isPlaying; }
</script>

<svelte:window on:keydown={onKeydown} />

<div
  class="video-player"
  class:sync-mode={syncMode}
  on:mousemove={onMouseMove}
  on:mouseleave={onMouseLeave}
>
  {#if src}
    <video
      bind:this={videoEl}
      {src}
      on:timeupdate={onTimeUpdate}
      on:play={onPlay}
      on:pause={onPause}
      on:loadedmetadata={() => {
        duration = videoEl?.duration ?? 0;
        dispatch('loadedmetadata', duration);
      }}
      on:click={togglePlay}
      crossorigin="anonymous"
    ></video>
  {:else}
    <div class="video-placeholder">
      <div class="placeholder-icon">🎬</div>
      <div class="placeholder-text">未上传视频</div>
      <div class="placeholder-hint">点击工具栏「上传视频」</div>
    </div>
  {/if}

  {#if syncMode}
    <div class="sync-badge">同步模式</div>
  {/if}

  <!-- 自定义控制条（仅在已上传视频时显示） -->
  {#if src}
    <div class="controls" class:visible={showControls || !isPlaying}>
      <button class="ctrl-btn" on:click={togglePlay} title={isPlaying ? '暂停 (空格)' : '播放 (空格)'} aria-label={isPlaying ? '暂停' : '播放'}>
        {#if isPlaying}
          <!-- 暂停图标 -->
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M3 2h4v12H3zm6 0h4v12H9z"/></svg>
        {:else}
          <!-- 播放图标 -->
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M3 2v12l10-6z"/></svg>
        {/if}
      </button>

      <span class="time">{fmt(currentTime)}</span>

      <div class="progress-bar" on:click={onProgressClick} title="点击跳转">
        <div class="progress-buffered" style="width: 0%"></div>
        <div class="progress-played" style="width: {duration ? (currentTime / duration) * 100 : 0}%"></div>
      </div>

      <span class="time time-total">{fmt(duration)}</span>

      <button class="ctrl-btn" on:click={toggleMute} title={muted ? '取消静音' : '静音'} aria-label={muted ? '取消静音' : '静音'}>
        {#if muted}
          <!-- 静音图标 -->
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M7 2L3 6H1v4h2l4 4V2zm3.5 3L9 6.5l1.5 1.5L9 9.5 10.5 11l1.5-1.5L13.5 11 15 9.5 13.5 8 15 6.5 13.5 5 12 6.5 10.5 5z"/></svg>
        {:else}
          <!-- 音量图标 -->
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M7 2L3 6H1v4h2l4 4V2zm3 2a4 4 0 010 8v-2a2 2 0 000-4V4z"/></svg>
        {/if}
      </button>

      <!-- 扩展按钮（放大/缩小视频区域） -->
      <button
        class="ctrl-btn expand-btn"
        on:click={() => dispatch('toggleExpand')}
        title={expanded ? '缩小视频区域' : '放大视频区域至 60%'}
        aria-label={expanded ? '缩小视频区域' : '放大视频区域'}
      >
        {#if expanded}
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M1 1h5v2H3v3H1V1zm14 0v5h-2V3h-3V1h5zM1 15v-5h2v3h3v2H1zm14 0h-5v-2h3v-3h2v5z"/></svg>
        {:else}
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M6 1v2H3v3H1V1h5zm4 0h5v5h-2V3h-3V1zM1 15v-5h2v3h3v2H1zm14 0h-5v-2h3v-3h2v5z"/></svg>
        {/if}
      </button>
    </div>
  {/if}
</div>

<style>
  .video-player {
    position: relative;
    width: 100%;
    aspect-ratio: 16 / 9;
    max-height: 70vh;
    background: #000;
    border-radius: 8px;
    overflow: hidden;
    min-height: 0;
    flex-shrink: 1;
  }
  .video-player video {
    width: 100%;
    height: 100%;
    display: block;
    object-fit: contain;
    cursor: pointer;
  }
  .video-placeholder {
    position: absolute; inset: 0;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    color: #57606a; background: #1a1a2e;
    gap: 8px;
  }
  .placeholder-icon { font-size: 56px; opacity: 0.6; }
  .placeholder-text { font-size: 16px; color: #c9d1d9; font-weight: 500; }
  .placeholder-hint { font-size: 12px; color: #6e7681; }
  .sync-mode {
    box-shadow: 0 0 0 3px #ff3333;
  }
  .sync-badge {
    position: absolute;
    top: 8px;
    left: 8px;
    background: #ff3333;
    color: white;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: bold;
    z-index: 6;
  }
  /* 自定义控制条 */
  .controls {
    position: absolute;
    left: 0; right: 0; bottom: 0;
    display: flex; align-items: center; gap: 8px;
    padding: 6px 10px;
    background: linear-gradient(to top, rgba(0,0,0,0.75), rgba(0,0,0,0));
    opacity: 0;
    transition: opacity 0.2s;
    z-index: 5;
  }
  .controls.visible { opacity: 1; }
  .ctrl-btn {
    width: 28px; height: 28px;
    display: flex; align-items: center; justify-content: center;
    background: none; color: white;
    border: none; border-radius: 4px;
    cursor: pointer; padding: 0;
    flex-shrink: 0;
  }
  .ctrl-btn:hover { background: rgba(255,255,255,0.15); }
  .expand-btn { margin-left: auto; }
  .time {
    color: #e6e6e6; font-size: 11px;
    font-family: 'SF Mono', Monaco, monospace;
    min-width: 36px; text-align: center;
    flex-shrink: 0;
  }
  .time-total { color: #9aa0a6; }
  .progress-bar {
    flex: 1; height: 5px;
    background: rgba(255,255,255,0.25);
    border-radius: 3px;
    cursor: pointer;
    position: relative;
    min-width: 60px;
  }
  .progress-bar:hover { height: 7px; }
  .progress-played {
    height: 100%;
    background: #0969da;
    border-radius: 3px;
    position: relative;
    transition: width 0.05s linear;
  }
  .progress-played::after {
    content: '';
    position: absolute;
    right: -5px; top: 50%;
    transform: translateY(-50%);
    width: 10px; height: 10px;
    background: #0969da;
    border-radius: 50%;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .progress-bar:hover .progress-played::after { opacity: 1; }
  .progress-buffered {
    height: 100%;
    background: rgba(255,255,255,0.35);
    border-radius: 3px;
    position: absolute;
    left: 0; top: 0;
  }
</style>

<script lang="ts">
  /**
   * 波形显示组件
   * - Canvas 渲染波形、静音区、口述条目区、播放头
   * - 点击波形跳转视频位置（空白段秒级定位）
   * - 双击空白区创建新口述条目
   */
  import { onMount, createEventDispatcher } from 'svelte';
  import { WaveformRenderer } from '../lib/render/waveform-renderer';
  import type { WaveformData } from '../lib/audio/audio-analyzer';
  import type { SilenceRegion } from '../lib/audio/silence-detector';
  import type { AssEvent } from '../types/ass';

  interface Props {
    waveform: WaveformData | null;
    currentTime: number;
    silenceRegions: SilenceRegion[];
    events: AssEvent[];
    zoom?: number;
    scrollOffset?: number;
    /** 是否启用拖选区间（owner/manager 工作分配模式） */
    dragSelectEnabled?: boolean;
  }

  let {
    waveform,
    currentTime,
    silenceRegions,
    events,
    zoom = 1,
    scrollOffset = 0,
    dragSelectEnabled = false,
  }: Props = $props();

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let renderer: WaveformRenderer | null = $state(null);
  let canvasWidth = $state(800);
  let canvasHeight = $state(120);

  // 拖选状态
  let isDragging = $state(false);
  let dragStartX = $state(0);
  let dragCurrentX = $state(0);

  const dispatch = createEventDispatcher<{
    seek: number;
    createEntry: { start: number; end: number };
    /** 拖选区间结束（mouseup 时触发），用于工作分配 */
    selectRange: { start: number; end: number };
  }>();

  onMount(() => {
    if (canvasEl) {
      renderer = new WaveformRenderer(canvasEl);
      // 响应式监听容器宽度
      const resizeObserver = new ResizeObserver(() => {
        if (canvasEl) {
          const cssWidth = canvasEl.clientWidth;
          const dpr = window.devicePixelRatio || 1;
          // 绘图缓冲区 = CSS 宽度 × DPR（高清屏不模糊）
          canvasEl.width = cssWidth * dpr;
          canvasEl.height = canvasHeight * dpr;
          // 传给 renderer 的 canvasWidth 用 CSS 宽度（坐标计算基准），
          // renderer 内部 ctx.scale(dpr, dpr) 处理高清
          canvasWidth = cssWidth;
          const ctx = canvasEl.getContext('2d');
          if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          render();
        }
      });
      resizeObserver.observe(canvasEl);
      return () => resizeObserver.disconnect();
    }
  });

  function render() {
    if (!renderer || !waveform) return;
    renderer.render({
      peaks: waveform.peaks,
      duration: waveform.duration,
      currentTime,
      zoom,
      scrollOffset,
      silenceRegions,
      events: events.map(e => ({
        start: e.start,
        end: e.end,
        layer: e.layer,
        status: e._status,
      })),
      canvasWidth,
      canvasHeight,
    });
  }

  // 依赖变化时重绘
  $effect(() => {
    render();
  });

  function onClick(e: MouseEvent) {
    if (!renderer || !waveform || !canvasEl) return;
    // 拖选模式：click 由 mousedown/mouseup 处理，此处不触发 seek
    if (dragSelectEnabled) return;
    const rect = canvasEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const time = renderer.pixelToTime(x, waveform.duration, zoom, scrollOffset, canvasWidth);
    dispatch('seek', time);
  }

  function onDblClick(e: MouseEvent) {
    if (!renderer || !waveform || !canvasEl) return;
    if (dragSelectEnabled) return; // 拖选模式下禁用双击创建
    const rect = canvasEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const time = renderer.pixelToTime(x, waveform.duration, zoom, scrollOffset, canvasWidth);
    // 双击空白区：在该静音段创建口述条目
    const region = silenceRegions.find(r => time >= r.start && time <= r.end);
    if (region) {
      dispatch('createEntry', { start: region.start, end: region.end });
    }
  }

  // ===== 拖选区间（工作分配模式）=====
  function onMouseDown(e: MouseEvent) {
    if (!dragSelectEnabled || !renderer || !waveform || !canvasEl) return;
    const rect = canvasEl.getBoundingClientRect();
    dragStartX = e.clientX - rect.left;
    dragCurrentX = dragStartX;
    isDragging = true;
    e.preventDefault();
  }

  function onMouseMove(e: MouseEvent) {
    if (!dragSelectEnabled || !isDragging || !canvasEl) return;
    const rect = canvasEl.getBoundingClientRect();
    dragCurrentX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
  }

  function onMouseUp(e: MouseEvent) {
    if (!dragSelectEnabled || !isDragging || !renderer || !waveform || !canvasEl) return;
    isDragging = false;
    const rect = canvasEl.getBoundingClientRect();
    const endX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const x1 = Math.min(dragStartX, endX);
    const x2 = Math.max(dragStartX, endX);
    // 拖动距离过小视为点击
    if (x2 - x1 < 4) {
      const time = renderer.pixelToTime(dragStartX, waveform.duration, zoom, scrollOffset, canvasWidth);
      dispatch('seek', time);
      return;
    }
    const startTime = renderer.pixelToTime(x1, waveform.duration, zoom, scrollOffset, canvasWidth);
    const endTime = renderer.pixelToTime(x2, waveform.duration, zoom, scrollOffset, canvasWidth);
    dispatch('selectRange', { start: startTime, end: endTime });
  }

  function onMouseLeave() {
    if (isDragging) isDragging = false;
  }

  // 拖选覆盖层位置（CSS 像素）
  let dragOverlayStyle = $derived.by(() => {
    if (!isDragging) return null;
    const x1 = Math.min(dragStartX, dragCurrentX);
    const width = Math.abs(dragCurrentX - dragStartX);
    return `left: ${x1}px; width: ${width}px;`;
  });

</script>

<div class="waveform-container" class:drag-mode={dragSelectEnabled}>
  {#if waveform}
    <div class="canvas-wrap">
      <canvas
        bind:this={canvasEl}
        width={canvasWidth}
        height={canvasHeight}
        on:click={onClick}
        on:dblclick={onDblClick}
        on:mousedown={onMouseDown}
        on:mousemove={onMouseMove}
        on:mouseup={onMouseUp}
        on:mouseleave={onMouseLeave}
      ></canvas>
      {#if dragOverlayStyle}
        <div class="drag-overlay" style={dragOverlayStyle}></div>
      {/if}
    </div>
    {#if dragSelectEnabled}
      <div class="drag-hint">🎯 拖选区间以新建并指派（点击则跳转）</div>
    {/if}
  {:else}
    <div class="placeholder">请加载视频以提取波形</div>
  {/if}
</div>

<style>
  .waveform-container {
    width: 100%;
    background: #1a1a2e;
    border-radius: 4px;
    overflow: hidden;
  }
  .waveform-container.drag-mode {
    background: #2a1a3e;
    box-shadow: 0 0 0 2px #d29922 inset;
  }
  .canvas-wrap {
    position: relative;
    width: 100%;
  }
  canvas {
    display: block;
    width: 100%;
    cursor: pointer;
  }
  .drag-mode canvas {
    cursor: crosshair;
  }
  .drag-overlay {
    position: absolute;
    top: 0;
    height: 100%;
    background: rgba(210, 153, 34, 0.35);
    border-left: 1px solid #d29922;
    border-right: 1px solid #d29922;
    pointer-events: none;
  }
  .drag-hint {
    padding: 4px 8px;
    color: #d29922;
    font-size: 12px;
    background: rgba(0, 0, 0, 0.3);
  }
  .placeholder {
    height: 120px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #666;
    font-size: 14px;
  }
</style>

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
  }

  let {
    waveform,
    currentTime,
    silenceRegions,
    events,
    zoom = 1,
    scrollOffset = 0,
  }: Props = $props();

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let renderer: WaveformRenderer | null = $state(null);
  let canvasWidth = $state(800);
  let canvasHeight = $state(120);

  const dispatch = createEventDispatcher<{
    seek: number;
    createEntry: { start: number; end: number };
  }>();

  onMount(() => {
    if (canvasEl) {
      renderer = new WaveformRenderer(canvasEl);
      // 响应式监听容器宽度
      const resizeObserver = new ResizeObserver(() => {
        if (canvasEl) {
          canvasWidth = canvasEl.clientWidth;
          canvasEl.width = canvasWidth;
          canvasEl.height = canvasHeight;
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
    const rect = canvasEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const time = renderer.pixelToTime(x, waveform.duration, zoom, scrollOffset, canvasWidth);
    dispatch('seek', time);
  }

  function onDblClick(e: MouseEvent) {
    if (!renderer || !waveform || !canvasEl) return;
    const rect = canvasEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const time = renderer.pixelToTime(x, waveform.duration, zoom, scrollOffset, canvasWidth);
    // 双击空白区：在该静音段创建口述条目
    const region = silenceRegions.find(r => time >= r.start && time <= r.end);
    if (region) {
      dispatch('createEntry', { start: region.start, end: region.end });
    }
  }

</script>

<div class="waveform-container">
  {#if waveform}
    <canvas
      bind:this={canvasEl}
      width={canvasWidth}
      height={canvasHeight}
      on:click={onClick}
      on:dblclick={onDblClick}
    ></canvas>
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
  canvas {
    display: block;
    width: 100%;
    cursor: pointer;
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

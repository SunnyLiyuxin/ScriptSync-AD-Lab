/**
 * 波形 Canvas 渲染器
 * 复用 ScriptSync 渲染要点：虚拟化只绘可视区域、静音区高亮、播放头、口述条目区
 */
import type { WaveformData } from '../audio/audio-analyzer';
import type { SilenceRegion } from '../audio/silence-detector';

export interface WaveformRenderOptions {
  peaks: Float32Array;
  duration: number;
  currentTime: number;
  zoom: number;          // 缩放倍率，1=全量
  scrollOffset: number;  // 水平滚动偏移（秒）
  silenceRegions: SilenceRegion[];
  events: { start: number; end: number; layer: number; status: string }[];
  canvasWidth: number;
  canvasHeight: number;
}

const COLORS = {
  waveform: '#4a90d9',
  waveformDim: '#2a5a8a',
  silence: 'rgba(255, 165, 0, 0.2)',     // 橙色半透明：静音区
  narration: 'rgba(0, 128, 255, 0.25)',  // 蓝色半透明：已有口述
  playhead: '#ff3333',
  centerLine: 'rgba(255,255,255,0.1)',
};

export class WaveformRenderer {
  private ctx: CanvasRenderingContext2D;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context not available');
    this.ctx = ctx;
  }

  render(opts: WaveformRenderOptions): void {
    const { ctx } = this;
    const w = opts.canvasWidth;
    const h = opts.canvasHeight;
    const mid = h / 2;

    // 1. 清空
    ctx.clearRect(0, 0, w, h);

    // 计算可视范围（秒）
    const visibleDuration = opts.duration / opts.zoom;
    const viewStart = opts.scrollOffset;
    const viewEnd = viewStart + visibleDuration;
    const secPerPixel = visibleDuration / w;

    // 2. 绘制静音区（橙色半透明背景）
    ctx.fillStyle = COLORS.silence;
    for (const r of opts.silenceRegions) {
      if (r.end < viewStart || r.start > viewEnd) continue;
      const x1 = Math.max(0, (r.start - viewStart) / secPerPixel);
      const x2 = Math.min(w, (r.end - viewStart) / secPerPixel);
      ctx.fillRect(x1, 0, x2 - x1, h);
    }

    // 3. 绘制口述条目区（蓝色半透明）
    ctx.fillStyle = COLORS.narration;
    for (const e of opts.events) {
      if (e.layer !== 1 || e.status === 'deleted') continue;
      if (e.end < viewStart || e.start > viewEnd) continue;
      const x1 = Math.max(0, (e.start - viewStart) / secPerPixel);
      const x2 = Math.min(w, (e.end - viewStart) / secPerPixel);
      ctx.fillRect(x1, 0, x2 - x1, h);
    }

    // 4. 绘制波形柱（虚拟化：只绘可视区域）
    const peaks = opts.peaks;
    const totalPeaks = peaks.length;
    const peaksPerSec = totalPeaks / opts.duration;
    const visiblePeaks = Math.floor(visibleDuration * peaksPerSec);
    const startPeak = Math.floor(viewStart * peaksPerSec);
    const barWidth = w / visiblePeaks;

    ctx.fillStyle = COLORS.waveform;
    for (let i = 0; i < visiblePeaks; i++) {
      const peakIdx = startPeak + i;
      if (peakIdx >= totalPeaks) break;
      const peak = peaks[peakIdx];
      const barHeight = peak * h * 0.8;
      const x = i * barWidth;
      ctx.fillRect(x, mid - barHeight / 2, Math.max(1, barWidth - 0.5), barHeight);
    }

    // 5. 中心线
    ctx.strokeStyle = COLORS.centerLine;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();

    // 6. 播放头（红色竖线）
    if (opts.currentTime >= viewStart && opts.currentTime <= viewEnd) {
      const x = (opts.currentTime - viewStart) / secPerPixel;
      ctx.strokeStyle = COLORS.playhead;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }

  /**
   * 像素坐标 → 时间（点击波形跳转用）
   */
  pixelToTime(x: number, duration: number, zoom: number, scrollOffset: number, canvasWidth: number): number {
    const visibleDuration = duration / zoom;
    const secPerPixel = visibleDuration / canvasWidth;
    return scrollOffset + x * secPerPixel;
  }
}

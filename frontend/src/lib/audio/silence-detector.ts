/**
 * 静音检测
 * 复用 ScriptSync 算法：阈值 + 最小时长 + 合并间隔
 * 用于自动打轴——识别影片中的空白段（可插口述解说）
 */

export interface SilenceRegion {
  start: number;       // 开始时间（秒）
  end: number;         // 结束时间（秒）
  hasEntry: boolean;   // 该空白段是否已有口述条目（编辑后标记）
}

export interface SilenceDetectOptions {
  threshold: number;       // 静音阈值（0~1，低于此值视为静音）
  minDuration: number;     // 最小静音时长（秒），短于此值忽略
  mergeGap: number;        // 合并间隔（秒），相邻静音段间距小于此值则合并
}

export const DEFAULT_SILENCE_OPTIONS: SilenceDetectOptions = {
  threshold: 0.05,     // 经验值：人声通常 > 0.1，背景音乐 > 0.05
  minDuration: 1.0,    // 至少 1 秒空白才有插口述的价值
  mergeGap: 0.3,       // 300ms 以内的间隙合并为一段
};

/**
 * 检测静音区域
 * @param peaks 波形峰值数组
 * @param duration 总时长
 * @param opts 检测参数
 */
export function detectSilence(
  peaks: Float32Array,
  duration: number,
  opts: SilenceDetectOptions = DEFAULT_SILENCE_OPTIONS,
): SilenceRegion[] {
  const secPerPeak = duration / peaks.length;
  const rawRegions: SilenceRegion[] = [];
  let start: number | null = null;

  for (let i = 0; i < peaks.length; i++) {
    if (peaks[i] < opts.threshold) {
      if (start === null) start = i * secPerPeak;
    } else {
      if (start !== null) {
        const end = i * secPerPeak;
        if (end - start >= opts.minDuration) {
          rawRegions.push({ start, end, hasEntry: false });
        }
        start = null;
      }
    }
  }
  // 处理末尾静音
  if (start !== null) {
    const end = duration;
    if (end - start >= opts.minDuration) {
      rawRegions.push({ start, end, hasEntry: false });
    }
  }

  return mergeRegions(rawRegions, opts.mergeGap);
}

/**
 * 合并相邻静音段（间距小于 mergeGap 的合并为一段）
 */
function mergeRegions(regions: SilenceRegion[], mergeGap: number): SilenceRegion[] {
  if (regions.length === 0) return [];
  const merged: SilenceRegion[] = [{ ...regions[0] }];

  for (let i = 1; i < regions.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = regions[i];
    if (cur.start - prev.end <= mergeGap) {
      // 合并：延伸前一段的结束时间
      prev.end = cur.end;
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/**
 * 标记已有口述条目的空白段
 * @param regions 静音区域列表
 * @param events 字幕事件列表（layer=1 为口述）
 */
export function markOccupiedRegions(
  regions: SilenceRegion[],
  events: { start: number; end: number; layer: number }[],
): SilenceRegion[] {
  const narrationEvents = events.filter(e => e.layer === 1);
  return regions.map(r => {
    const hasEntry = narrationEvents.some(
      e => e.start < r.end && e.end > r.start,
    );
    return { ...r, hasEntry };
  });
}

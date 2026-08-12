/**
 * ASS / SRT / WebVTT 时间格式互转工具
 * 复用 ScriptGrid/ScriptSync 已验证的时间转换逻辑
 * ASS 厘秒(1/100s) ↔ SRT 毫秒(1/1000s) ↔ 内部秒(浮点)
 */

/**
 * ASS 时间字符串 "H:MM:SS.cc" → 秒（浮点）
 * 例: "0:01:23.45" → 83.45
 */
export function assTimeToSeconds(t: string): number {
  const m = t.trim().match(/^(\d+):(\d{2}):(\d{2})\.(\d{2})$/);
  if (!m) return 0;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 100;
}

/**
 * 秒 → ASS 时间字符串 "H:MM:SS.cc"
 * 例: 83.45 → "0:01:23.45"
 */
export function secondsToAssTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.round((s % 1) * 100);
  // 处理进位：cs 为 100 时进位到秒
  const adjusted = cs === 100 ? { sec: sec + 1, cs: 0 } : { sec, cs };
  const finalSec = adjusted.sec === 60 ? { m: m + 1, sec: 0 } : { m, sec: adjusted.sec };
  return `${h}:${String(finalSec.m).padStart(2, '0')}:${String(finalSec.sec).padStart(2, '0')}.${String(adjusted.cs).padStart(2, '0')}`;
}

/**
 * 秒 → SRT 时间字符串 "HH:MM:SS,mmm"
 * 例: 83.451 → "00:01:23,451"
 */
export function secondsToSrtTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s % 1) * 1000);
  const adjusted = ms === 1000 ? { sec: sec + 1, ms: 0 } : { sec, ms };
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(adjusted.sec).padStart(2, '0')},${String(adjusted.ms).padStart(3, '0')}`;
}

/**
 * SRT 时间字符串 "HH:MM:SS,mmm" → 秒
 */
export function srtTimeToSeconds(t: string): number {
  const m = t.trim().match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!m) return 0;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
}

/**
 * 秒 → WebVTT 时间字符串 "HH:MM:SS.mmm"
 * 例: 83.451 → "00:01:23.451"
 */
export function secondsToVttTime(s: number): string {
  return secondsToSrtTime(s).replace(',', '.');
}

/**
 * 秒 → 可读时间戳 "MM:SS" 或 "H:MM:SS"（UI 展示用）
 */
export function formatDisplayTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

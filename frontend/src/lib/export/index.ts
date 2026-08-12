/**
 * 导出中心 - 统一导出入口
 * 整合 ASS / SRT / WebVTT / Excel 导出，前端直接生成并下载。
 * 复用 ass/serializer、ass/time-utils、ass/tag-parser 的已验证逻辑。
 */
import type { AssEvent, AssStyle } from '../../types/ass';
import { serializeToAss } from '../ass/serializer';
import { secondsToAssTime, secondsToSrtTime, secondsToVttTime } from '../ass/time-utils';
import { stripAllTags, assNewlinesToReal } from '../ass/tag-parser';

// 重新导出已有模块，保持向后兼容
export { exportAss } from './export-ass';
export { exportSrt } from './export-srt';
export { exportExcel } from './export-excel';

/** 过滤已删除并按开始时间排序 */
function sortActive(events: AssEvent[]): AssEvent[] {
  return [...events]
    .filter(e => e._status !== 'deleted')
    .sort((a, b) => a.start - b.start);
}

/**
 * 导出为 ASS 文本（调用现有 serializeToAss）
 * @param events 字幕事件
 * @param scriptInfo [Script Info] 头
 * @param styles 样式列表
 */
export function exportToAss(
  events: AssEvent[],
  scriptInfo: Record<string, string> = {},
  styles: AssStyle[] = [],
): string {
  return serializeToAss({ scriptInfo, styles, events }, false);
}

/**
 * 导出为 SRT 文本（剥离 {\xxx} 标签，时间 HH:MM:SS,mmm）
 */
export function exportToSrt(events: AssEvent[]): string {
  const sorted = sortActive(events);
  return sorted
    .map((e, i) => {
      const text = assNewlinesToReal(stripAllTags(e.text));
      return `${i + 1}\n${secondsToSrtTime(e.start)} --> ${secondsToSrtTime(e.end)}\n${text}\n`;
    })
    .join('\n');
}

/**
 * 导出为 WebVTT 文本（WEBVTT 头，时间 HH:MM:SS.mmm，点分隔）
 */
export function exportToVtt(events: AssEvent[]): string {
  const sorted = sortActive(events);
  const cues = sorted.map((e, i) => {
    const text = assNewlinesToReal(stripAllTags(e.text));
    return `${i + 1}\n${secondsToVttTime(e.start)} --> ${secondsToVttTime(e.end)}\n${text}`;
  });
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * 导出为 Excel（SheetJS 动态导入），返回 Blob 供下载。
 * 列：序号 / 开始 / 结束 / 类型 / 负责 / 内容 / 状态
 */
export async function exportToExcel(events: AssEvent[]): Promise<Blob> {
  const XLSX = await import('xlsx');
  const rows = sortActive(events).map((e, i) => ({
    '序号': i + 1,
    '开始': secondsToAssTime(e.start),
    '结束': secondsToAssTime(e.end),
    '类型': e.layer === 0 ? '对白' : '口述',
    '负责': e._assignedTo ?? '',
    '内容': assNewlinesToReal(stripAllTags(e.text)),
    '状态': e._status,
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, '口述稿');
  const data = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Blob([data], { type: EXCEL_MIME });
}

/**
 * 触发浏览器下载
 * @param content 字符串或 Blob
 * @param filename 文件名
 * @param mime 字符串内容的 MIME 类型（content 为 Blob 时忽略）
 */
export function downloadFile(
  content: string | Blob,
  filename: string,
  mime: string,
): void {
  const blob = content instanceof Blob
    ? content
    : new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

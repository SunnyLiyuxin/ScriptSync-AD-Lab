/**
 * Excel 导出（动态导入 SheetJS，减小首屏体积）
 * 复用 ScriptGrid 的 Excel 表头契约：["序号","开始时间","结束时间","字幕内容"]
 */
import type { AssEvent } from '../../types/ass';
import { secondsToAssTime } from '../ass/time-utils';
import { stripAllTags, assNewlinesToReal } from '../ass/tag-parser';

export async function exportExcel(
  events: AssEvent[],
  filename: string,
): Promise<void> {
  const XLSX = await import('xlsx');

  const rows = events
    .filter(e => e._status !== 'deleted')
    .sort((a, b) => a.start - b.start)
    .map((e, i) => ({
      '序号': i + 1,
      '开始时间': secondsToAssTime(e.start),
      '结束时间': secondsToAssTime(e.end),
      '类型': e.layer === 0 ? '对白' : '口述',
      '内容': assNewlinesToReal(stripAllTags(e.text)),
      '状态': e._status,
      '指派': e._assignedTo || '',
    }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, '口述稿');
  XLSX.writeFile(wb, filename);
}

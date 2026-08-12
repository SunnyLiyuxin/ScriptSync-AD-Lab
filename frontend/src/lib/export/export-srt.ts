/**
 * SRT 导出
 * 复用 ScriptGrid/ScriptSync 的 SRT 序列化逻辑
 */
import type { AssEvent } from '../../types/ass';
import { secondsToSrtTime } from '../ass/time-utils';
import { stripAllTags, assNewlinesToReal } from '../ass/tag-parser';

export function exportSrt(events: AssEvent[]): string {
  const sorted = [...events]
    .filter(e => e._status !== 'deleted')
    .sort((a, b) => a.start - b.start);

  return sorted
    .map((e, i) => {
      const text = assNewlinesToReal(stripAllTags(e.text));
      return `${i + 1}\n${secondsToSrtTime(e.start)} --> ${secondsToSrtTime(e.end)}\n${text}\n`;
    })
    .join('\n');
}

/**
 * ASS 导出（复用 serializer）
 */
import type { AssDocument, AssEvent } from '../../types/ass';
import { serializeToAss } from '../ass/serializer';

export function exportAss(
  events: AssEvent[],
  scriptInfo: Record<string, string> = {},
  styles: AssDocument['styles'] = [],
): string {
  const doc: AssDocument = { scriptInfo, styles, events };
  return serializeToAss(doc, false);
}

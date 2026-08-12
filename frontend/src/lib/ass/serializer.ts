/**
 * ASS 序列化器（导出）
 * 将 AssDocument 序列化为标准 ASS 文本
 * 复用 ScriptGrid/ScriptSync 验证过的格式规范
 */
import type { AssDocument, AssEvent, AssStyle } from '../../types/ass';
import { secondsToAssTime } from './time-utils';

const STYLE_FORMAT = 'Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding';
const EVENT_FORMAT = 'Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text';

/**
 * 序列化为 ASS 文本
 * @param doc ASS 文档
 * @param includeMeta 是否包含协作元数据（导出给第三方工具时设为 false）
 */
export function serializeToAss(doc: AssDocument, includeMeta = false): string {
  const out: string[] = [];

  // [Script Info]
  out.push('[Script Info]');
  for (const [k, v] of Object.entries(doc.scriptInfo)) {
    out.push(`${k}: ${v}`);
  }

  // [V4+ Styles]
  out.push('');
  out.push('[V4+ Styles]');
  out.push(`Format: ${STYLE_FORMAT}`);
  for (const s of doc.styles) {
    out.push(`Style: ${serializeStyle(s)}`);
  }

  // [Events]
  out.push('');
  out.push('[Events]');
  out.push(`Format: ${EVENT_FORMAT}`);
  const sortedEvents = [...doc.events]
    .filter(e => e._status !== 'deleted')
    .sort((a, b) => a.start - b.start || a.layer - b.layer);
  for (const e of sortedEvents) {
    out.push(`Dialogue: ${serializeEvent(e)}`);
  }

  return out.join('\n') + '\n';
}

function serializeStyle(s: AssStyle): string {
  const boolStr = (b: boolean) => b ? '-1' : '0';
  return [
    s.Name, s.Fontname, s.Fontsize, s.PrimaryColour, s.SecondaryColour,
    s.OutlineColour, s.BackColour, boolStr(s.Bold), boolStr(s.Italic),
    boolStr(s.Underline), boolStr(s.StrikeOut), s.ScaleX, s.ScaleY,
    s.Spacing, s.Angle, s.BorderStyle, s.Outline, s.Shadow, s.Alignment,
    s.MarginL, s.MarginR, s.MarginV, s.Encoding,
  ].join(',');
}

function serializeEvent(e: AssEvent): string {
  return [
    e.layer,
    secondsToAssTime(e.start),
    secondsToAssTime(e.end),
    e.style,
    e.name || '',
    '0', '0', '0', '',
    e.text,
  ].join(',');
}

/**
 * ASS 解析器
 * 从 ScriptSync 移植，适配本项目 AssEvent 类型
 * 核心思路：
 * - 状态机按段（[Script Info]/[V4+ Styles]/[Events]）解析
 * - Format 行动态映射字段位置
 * - Dialogue 行 maxsplit 防 Text 内逗号误切
 */
import { nanoid } from 'nanoid';
import type { AssDocument, AssEvent, AssStyle, EventStatus } from '../../types/ass';
import { assTimeToSeconds } from './time-utils';

/** 默认新建事件状态 */
const DEFAULT_STATUS: EventStatus = 'draft';

/**
 * 解析 ASS 文本为 AssDocument
 */
export function parseAss(content: string): AssDocument {
  // 去 BOM
  const text = content.replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);

  const scriptInfo: Record<string, string> = {};
  const styles: AssStyle[] = [];
  const events: AssEvent[] = [];

  let section = '';
  // Events 段 Format 字段数量，用于 Dialogue 行安全分割
  let formatFieldCount = 10;
  // Format 行字段名→索引映射
  let formatMap: Record<string, number> = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // 段落切换
    if (line === '[Script Info]') { section = 'info'; continue; }
    if (line === '[V4+ Styles]' || line === '[V4 Styles]') { section = 'styles'; continue; }
    if (line === '[Events]') { section = 'events'; continue; }

    if (section === 'info') {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const k = line.substring(0, idx).trim();
        const v = line.substring(idx + 1).trim();
        scriptInfo[k] = v;
      }
    } else if (section === 'styles') {
      if (line.startsWith('Format:')) continue; // Format 行仅作参考，按固定顺序解析
      if (line.startsWith('Style:')) {
        const style = parseStyleLine(line);
        if (style) styles.push(style);
      }
    } else if (section === 'events') {
      if (line.startsWith('Format:')) {
        const fields = line.replace('Format:', '').split(',').map(s => s.trim().toLowerCase());
        formatFieldCount = fields.length;
        formatMap = {};
        fields.forEach((f, i) => { formatMap[f] = i; });
      } else if (line.startsWith('Dialogue:') || line.startsWith('Comment:')) {
        const ev = parseDialogueLine(line, formatMap, formatFieldCount);
        if (ev) events.push(ev);
      }
    }
  }

  return { scriptInfo, styles, events };
}

/**
 * 解析 Style 行
 * Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
 */
function parseStyleLine(line: string): AssStyle | null {
  const content = line.replace(/^Style:\s*/, '');
  const parts = content.split(',').map(s => s.trim());
  if (parts.length < 23) return null;
  const num = (i: number) => Number(parts[i]) || 0;
  const bool = (i: number) => parts[i] === '-1' || parts[i] === '1';
  return {
    Name: parts[0],
    Fontname: parts[1],
    Fontsize: num(2),
    PrimaryColour: parts[3],
    SecondaryColour: parts[4],
    OutlineColour: parts[5],
    BackColour: parts[6],
    Bold: bool(7),
    Italic: bool(8),
    Underline: bool(9),
    StrikeOut: bool(10),
    ScaleX: num(11),
    ScaleY: num(12),
    Spacing: num(13),
    Angle: num(14),
    BorderStyle: num(15),
    Outline: num(16),
    Shadow: num(17),
    Alignment: num(18),
    MarginL: num(19),
    MarginR: num(20),
    MarginV: num(21),
    Encoding: num(22),
  };
}

/**
 * 解析 Dialogue/Comment 行
 * 关键：按 Format 行字段数 maxsplit，只 split 前 N-1 个逗号，最后一个字段全归 Text
 */
function parseDialogueLine(
  line: string,
  formatMap: Record<string, number>,
  fieldCount: number,
): AssEvent | null {
  const isComment = line.startsWith('Comment:');
  const content = line.replace(/^(Dialogue|Comment):\s*/, '');

  // 安全分割：循环 indexOf 取逗号，只切 fieldCount-1 次
  const parts: string[] = [];
  let remaining = content;
  for (let i = 0; i < fieldCount - 1; i++) {
    const idx = remaining.indexOf(',');
    if (idx === -1) return null; // 字段不足，格式错误
    parts.push(remaining.substring(0, idx));
    remaining = remaining.substring(idx + 1);
  }
  parts.push(remaining); // 最后全部归 Text

  // 从 formatMap 取字段位置，兼容不同 ASS 变体
  const layerIdx = formatMap['layer'] ?? 0;
  const startIdx = formatMap['start'] ?? 1;
  const endIdx = formatMap['end'] ?? 2;
  const styleIdx = formatMap['style'] ?? 3;
  const nameIdx = formatMap['name'] ?? 4;
  const textIdx = fieldCount - 1; // Text 永远是最后一个

  return {
    id: nanoid(),
    layer: parseInt(parts[layerIdx]) || 0,
    start: assTimeToSeconds(parts[startIdx]),
    end: assTimeToSeconds(parts[endIdx]),
    style: parts[styleIdx] || 'Default',
    name: parts[nameIdx] || '',
    text: parts[textIdx] || '',
    _status: isComment ? 'deleted' : DEFAULT_STATUS,
    _lockedBy: null,
    _assignedTo: null,
    _owner: null,
  };
}

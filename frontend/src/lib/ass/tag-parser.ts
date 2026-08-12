/**
 * ASS 内联标签解析
 * 复用 ScriptSync 思路：标签与正文分离，防止口述员误删 {\pos} 等定位标签
 * 相比 ScriptGrid 的 re.sub 一刀切清除，保留标签以供编辑后写回
 */
import type { InlineTagResult } from '../../types/ass';

const TAG_REGEX = /\{\\[^}]*\}/g;

/**
 * 解析 ASS 内联标签
 * 例: "{\\pos(960,900)}{\\fad(200,300)}文字" → { cleanText: "文字", tags: [...] }
 */
export function parseInlineTags(text: string): InlineTagResult {
  const tags: string[] = [];
  let clean = text;
  let match: RegExpExecArray | null;
  // 重置正则 lastIndex（全局正则复用安全）
  TAG_REGEX.lastIndex = 0;
  while ((match = TAG_REGEX.exec(text)) !== null) {
    tags.push(match[0]);
  }
  clean = text.replace(TAG_REGEX, '');
  return { rawText: text, cleanText: clean.trim(), tags };
}

/**
 * 合并标签与正文（编辑后写回）
 * 例: tags.join('') + editedText
 */
export function combineTagsAndText(tags: string[], text: string): string {
  if (tags.length === 0) return text;
  return tags.join('') + text;
}

/**
 * 提取特定类型的标签参数
 * 例: extractTagParam(text, 'pos') → { x: 960, y: 900 }
 */
export function extractTagParam(text: string, tagName: string): Record<string, number> | null {
  const regex = new RegExp(`\\{\\\\${tagName}\\(([^)]+)\\)\\}`);
  const match = text.match(regex);
  if (!match) return null;
  const params = match[1].split(',').map(Number);
  if (tagName === 'pos') return { x: params[0], y: params[1] };
  if (tagName === 'fad') return { in: params[0], out: params[1] };
  if (tagName === 'move') return { x1: params[0], y1: params[1], x2: params[2], y2: params[3], t1: params[4], t2: params[5] };
  return params.reduce((acc, v, i) => ({ ...acc, [`p${i}`]: v }), {});
}

/**
 * 清除所有标签（纯文本展示用，如 SRT 导出）
 */
export function stripAllTags(text: string): string {
  return text.replace(TAG_REGEX, '').trim();
}

/**
 * 将 ASS 换行符 \\N / \\n 转为真实换行
 */
export function assNewlinesToReal(text: string): string {
  return text.replace(/\\N/g, '\n').replace(/\\n/g, '\n');
}

/**
 * 将真实换行转回 ASS 换行符 \\N（导出 ASS 用）
 */
export function realNewlinesToAss(text: string): string {
  return text.replace(/\r?\n/g, '\\N');
}

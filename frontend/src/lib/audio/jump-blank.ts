/**
 * 空白段跳转（秒级定位）
 * 在静音段中定位「空白口述行」（text 为空且位于静音段内），
 * 支持向前/向后跳转，并聚焦该行 + 视频跳到对应时间。
 * 没有现成条目的静音段返回其起始时间，提示用户新建条目。
 */
import type * as Y from 'yjs';
import type { WebsocketProvider } from 'y-websocket';
import type { AssEvent } from '../../types/ass';
import type { SilenceRegion } from './silence-detector';
import { stripAllTags } from '../ass/tag-parser';
import { exportEvents } from '../collaboration/yjs-operations';

/** 跳转目标：命中条目时返回其 id 与时间；命中无条目静音段时仅返回时间 */
export interface BlankJumpTarget {
  eventId: string | null;
  time: number | null;
}

/** 视频播放器最小接口（与 VideoPlayer 组件导出方法一致） */
export interface VideoPlayerLike {
  seekTo: (time: number) => void;
  getCurrentTime: () => number;
}

/** 跳转方向 */
export type JumpDirection = 'next' | 'prev';

/** 跳转结果 */
export interface JumpResult {
  success: boolean;
  eventId: string | null;
  time: number | null;
}

/** 判断是否为空白口述行：layer=1（口述）、未删除、文本为空 */
function isEmptyNarration(e: AssEvent): boolean {
  if (e._status === 'deleted') return false;
  if (e.layer !== 1) return false;
  return stripAllTags(e.text).trim() === '';
}

/** 判断条目时间是否落在某个静音段内（允许相切/重叠） */
function isInSilence(e: { start: number; end: number }, regions: SilenceRegion[]): boolean {
  const s = e.start;
  const en = Number.isFinite(e.end) ? e.end : e.start;
  return regions.some(r => s < r.end && en > r.start);
}

/**
 * 找下一个空白口述行（currentTime 之后）。
 * 优先返回 text 为空且位于静音段内的条目；
 * 若无，回退到「没有现成条目的静音段」起始时间（提示新建条目）；
 * 若连静音段也没有，返回 { null, null }。
 *
 * 注：当 silenceRegions 为空时（未做静音检测），退化为返回任意空白口述行。
 */
export function findNextBlank(
  events: AssEvent[],
  silenceRegions: SilenceRegion[],
  currentTime: number,
): BlankJumpTarget {
  const blanks = events.filter(isEmptyNarration);
  const pool = silenceRegions.length > 0
    ? blanks.filter(e => isInSilence(e, silenceRegions))
    : blanks;

  const next = pool
    .filter(e => e.start > currentTime)
    .sort((a, b) => a.start - b.start)[0];
  if (next) return { eventId: next.id, time: next.start };

  // 回退：没有现成条目的静音段
  const region = silenceRegions
    .filter(r => !r.hasEntry && r.start > currentTime)
    .sort((a, b) => a.start - b.start)[0];
  if (region) return { eventId: null, time: region.start };

  return { eventId: null, time: null };
}

/**
 * 找上一个空白口述行（currentTime 之前）。
 */
export function findPrevBlank(
  events: AssEvent[],
  silenceRegions: SilenceRegion[],
  currentTime: number,
): BlankJumpTarget {
  const blanks = events.filter(isEmptyNarration);
  const pool = silenceRegions.length > 0
    ? blanks.filter(e => isInSilence(e, silenceRegions))
    : blanks;

  const prev = pool
    .filter(e => e.start < currentTime)
    .sort((a, b) => b.start - a.start)[0];
  if (prev) return { eventId: prev.id, time: prev.start };

  const region = silenceRegions
    .filter(r => !r.hasEntry && r.start < currentTime)
    .sort((a, b) => b.start - a.start)[0];
  if (region) return { eventId: null, time: region.start };

  return { eventId: null, time: null };
}

/**
 * 跳转到上/下一个空白口述行：
 * - 视频跳到对应时间
 * - 通过 awareness 设置本地光标 entryId，触发该行聚焦
 *
 * 注：本函数不持有静音段数据，故仅定位已有空白条目；
 * 需要静音段回退（无条目时返回静音段时间）的调用方请直接使用
 * findNextBlank/findPrevBlank。
 */
export function jumpToBlank(
  doc: Y.Doc,
  provider: WebsocketProvider,
  videoPlayer: VideoPlayerLike,
  direction: JumpDirection,
): JumpResult {
  const events = exportEvents(doc);
  const currentTime = videoPlayer.getCurrentTime();
  const target = direction === 'next'
    ? findNextBlank(events, [], currentTime)
    : findPrevBlank(events, [], currentTime);

  if (target.eventId) {
    const ev = events.find(e => e.id === target.eventId);
    if (ev) {
      videoPlayer.seekTo(ev.start);
      const cursor = provider.awareness.getLocalState()?.cursor as
        | { entryId: string | null; typing: boolean }
        | undefined;
      provider.awareness.setLocalStateField('cursor', {
        entryId: ev.id,
        typing: cursor?.typing ?? false,
      });
      return { success: true, eventId: ev.id, time: ev.start };
    }
  }

  return { success: false, eventId: null, time: null };
}

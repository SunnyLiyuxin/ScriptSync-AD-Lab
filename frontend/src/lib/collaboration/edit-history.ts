/**
 * 修改历史追踪（V1.5）
 * 基于 Yjs 的 editHistory Map，按 eventId 索引，值为 Y.Array<EditHistoryEntry>
 * 用 Y.UndoManager 包一层支持撤销最近一次 recordEdit
 *
 * 文档结构：
 *   doc.getMap('editHistory') → Y.Map<eventId, Y.Array<entryMap>>
 *     entryMap 字段: eventId / userId / username / timestamp / field / oldValue / newValue
 */
import * as Y from 'yjs';
import type { EditHistoryEntry } from '../../types/project';

/** 带 eventId 的修改记录（用于跨事件查询） */
export type EditHistoryEntryWithEvent = EditHistoryEntry & { eventId: string };

type EditEntryMap = Y.Map<unknown>;
type EditHistoryMap = Y.Map<Y.Array<EditEntryMap>>;

/** 从 Y.Map 读取一条修改记录 */
function readEntry(m: EditEntryMap, eventId: string): EditHistoryEntryWithEvent {
  return {
    eventId,
    userId: m.get('userId') as string,
    username: m.get('username') as string,
    timestamp: m.get('timestamp') as number,
    field: m.get('field') as EditHistoryEntry['field'],
    oldValue: m.get('oldValue') as string,
    newValue: m.get('newValue') as string,
  };
}

function getEditHistoryMap(doc: Y.Doc): EditHistoryMap {
  return doc.getMap<Y.Array<EditEntryMap>>('editHistory');
}

/**
 * 记录一次修改
 * 把修改记录追加到 Yjs editHistory Map 中对应 eventId 的 Y.Array
 */
export function recordEdit(
  doc: Y.Doc,
  eventId: string,
  field: 'text' | 'start' | 'end' | 'status',
  oldValue: string,
  newValue: string,
  userId: string,
  username: string,
): void {
  const editHistory = getEditHistoryMap(doc);
  let arr = editHistory.get(eventId);
  if (!arr) {
    arr = new Y.Array();
    editHistory.set(eventId, arr);
  }
  const entryMap = new Y.Map();
  entryMap.set('eventId', eventId);
  entryMap.set('userId', userId);
  entryMap.set('username', username);
  entryMap.set('timestamp', Date.now());
  entryMap.set('field', field);
  entryMap.set('oldValue', oldValue);
  entryMap.set('newValue', newValue);
  doc.transact(() => {
    arr.push([entryMap]);
  });
}

/**
 * 获取指定事件的修改历史（按时间正序）
 */
export function getEditHistory(doc: Y.Doc, eventId: string): EditHistoryEntry[] {
  const editHistory = getEditHistoryMap(doc);
  const arr = editHistory.get(eventId);
  if (!arr) return [];
  const result: EditHistoryEntry[] = [];
  for (let i = 0; i < arr.length; i++) {
    const m = arr.get(i);
    result.push({
      userId: m.get('userId') as string,
      username: m.get('username') as string,
      timestamp: m.get('timestamp') as number,
      field: m.get('field') as EditHistoryEntry['field'],
      oldValue: m.get('oldValue') as string,
      newValue: m.get('newValue') as string,
    });
  }
  return result;
}

/**
 * 获取全文档最近的修改记录（按时间倒序）
 * 返回的每条记录包含 eventId，便于 UI 展示"改了哪条"
 */
export function getAllRecentEdits(
  doc: Y.Doc,
  limit: number = 50,
): EditHistoryEntryWithEvent[] {
  const editHistory = getEditHistoryMap(doc);
  const all: EditHistoryEntryWithEvent[] = [];
  editHistory.forEach((arr, eventId) => {
    for (let i = 0; i < arr.length; i++) {
      all.push(readEntry(arr.get(i), eventId));
    }
  });
  all.sort((a, b) => b.timestamp - a.timestamp);
  return all.slice(0, limit);
}

/**
 * 创建修改历史的 UndoManager（支持撤销最近一次 recordEdit）
 * 调用方持有返回的 UndoManager，调用 .undo() / .redo() 即可
 */
export function createEditHistoryUndoManager(doc: Y.Doc): Y.UndoManager {
  const editHistory = getEditHistoryMap(doc);
  return new Y.UndoManager(editHistory, {
    trackedOrigins: new Set([doc.clientID]),
    captureTimeout: 0,
  });
}

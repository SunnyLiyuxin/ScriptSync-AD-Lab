/**
 * Yjs 协作层初始化
 * 复用 ScriptSync 架构，升级为自建 y-websocket 服务端
 * 文档结构：
 *   doc.getMap('meta')       → 项目元数据
 *   doc.getMap('scriptInfo') → ASS Script Info 头
 *   doc.getArray('styles')   → ASS 样式
 *   doc.getArray('events')   → 字幕事件（核心，高频操作）
 *   doc.getMap('comments')   → 审阅批注（按 eventId 索引）
 *   doc.getArray('assignments') → 段落分配
 */
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';

export interface CollabConfig {
  roomName: string;       // 房间名（项目ID）
  wsUrl: string;          // y-websocket 服务端地址
  token: string;          // JWT 鉴权 token
  userId: string;
  username: string;
  color: string;          // 协作光标颜色
}

export interface CollabInstance {
  doc: Y.Doc;
  provider: WebsocketProvider;
  persistence: IndexeddbPersistence;
  destroy: () => void;
}

/**
 * 初始化协作会话
 */
export function initCollab(config: CollabConfig): CollabInstance {
  const doc = new Y.Doc();

  // 本地持久化（离线缓存，source-of-truth 在服务端）
  const persistence = new IndexeddbPersistence(`ss-${config.roomName}`, doc);

  // 连接 y-websocket 服务端（自建，带 JWT 鉴权）
  const provider = new WebsocketProvider(
    config.wsUrl,
    config.roomName,
    doc,
    {
      // JWT 通过 query 参数传递，服务端校验后建立连接
      params: { token: config.token },
      // 关闭广播前等待，避免首屏闪烁
      connect: true,
    },
  );

  // 设置 awareness（在线状态、光标、播放状态）
  provider.awareness.setLocalStateField('user', {
    userId: config.userId,
    username: config.username,
    color: config.color,
  });
  provider.awareness.setLocalStateField('cursor', {
    entryId: null,
    typing: false,
  });

  return {
    doc,
    provider,
    persistence,
    destroy: () => {
      provider.disconnect();
      persistence.destroy();
      doc.destroy();
    },
  };
}

/**
 * 获取 Yjs 文档各集合的引用（便捷访问器）
 */
export function getDocCollections(doc: Y.Doc) {
  return {
    meta: doc.getMap<unknown>('meta'),
    scriptInfo: doc.getMap<string>('scriptInfo'),
    styles: doc.getArray<unknown>('styles'),
    events: doc.getArray<Y.Map<unknown>>('events'),
    comments: doc.getMap<unknown>('comments'),
    assignments: doc.getArray<unknown>('assignments'),
  };
}

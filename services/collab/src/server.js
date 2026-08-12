#!/usr/bin/env node
/**
 * y-websocket 协作服务端（V2）
 * - 基于 y-websocket 官方实现
 * - JWT 鉴权（通过 query 参数 token 传递）
 * - 房间隔离（按项目ID）
 * - 持久化回调钩子（供后续接入 OSS 快照）
 *
 * V2 新增（均挂载到同一个 http server，按路径区分）：
 *   * 同步播放 WebSocket  /sync-play/:projectId   —— src/sync-play.js
 *   * 语音房间信令        /voice-room              —— src/voice-room.js
 *   * Yjs 版本快照        /snapshot/*  HTTP 端点    —— src/snapshot.js
 */
import { WebSocketServer } from 'ws';
import * as http from 'http';
import * as Y from 'yjs';
import { setupWSConnection, setPersistence, docs, WSSharedDoc } from 'y-websocket/bin/utils';
import jwt from 'jsonwebtoken';
import { createSyncPlayServer } from './sync-play.js';
import { createVoiceRoomServer } from './voice-room.js';
import { createSnapshotManager } from './snapshot.js';

const PORT = process.env.PORT || 1234;
const JWT_SECRET = process.env.JWT_SECRET || 'scriptsync-dev-secret-change-in-prod';

// docs：来自 y-websocket utils 的真实活跃 Yjs 文档 Map（projectId -> WSSharedDoc）。
// 原 server.js 中的空 docs Map 已替换为真实实例，供 snapshot 模块直接使用。

/**
 * 鉴权中间件：校验 JWT，提取 userId / projectId
 * token 通过 query 参数传递（y-websocket 客户端 params.token）
 */
function authenticate(req, cb) {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  const roomName = url.pathname.slice(1);

  if (!token) {
    cb(new Error('Missing token'), null);
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // 校验 roomName 与 token 中的 projectId 一致（防越权进入其他项目房间）
    if (payload.projectId && payload.projectId !== roomName) {
      cb(new Error('Project mismatch'), null);
      return;
    }
    cb(null, { userId: payload.userId, username: payload.username, projectId: roomName });
  } catch (e) {
    cb(new Error('Invalid token'), null);
  }
}

/**
 * 持久化钩子（V2 接入 OSS）
 * MVP 阶段：每 30 秒或文档变更时记录日志
 */
setPersistence({
  bindState: (docName, ydoc) => {
    // TODO: 从 OSS 恢复文档快照
    console.log(`[persistence] bindState: ${docName}`);
  },
  writeState: async (docName, ydoc) => {
    // TODO: 将 ydoc 快照写入 OSS
    const update = Y.encodeStateAsUpdate(ydoc);
    console.log(`[persistence] writeState: ${docName}, size=${update.length} bytes`);
  },
});

// 版本快照管理器：注入真实 docs Map；回滚时用 WSSharedDoc 构造新文档以兼容 y-websocket
const snapshotManager = createSnapshotManager(docs, {
  createDoc: (name) => new WSSharedDoc(name),
});

const server = http.createServer(async (req, res) => {
  // 先交给快照路由处理 /snapshot/* 端点
  try {
    const handled = await snapshotManager.handleHttp(req, res);
    if (handled) return;
  } catch {
    /* 落到默认响应 */
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ScriptSync Collaboration Server (y-websocket)');
});

// y-websocket：catch-all upgrade（跳过 sync-play / voice-room 保留前缀，
// 这两个前缀由各自模块注册的 upgrade 监听器处理）
const wss = new WebSocketServer({ noServer: true });

function isReservedPath(pathname) {
  return (
    pathname.startsWith('/sync-play/') ||
    pathname === '/voice-room' ||
    pathname.startsWith('/voice-room/')
  );
}

server.on('upgrade', (req, socket, head) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    pathname = req.url ? req.url.split('?')[0] : '';
  }
  if (isReservedPath(pathname)) return;

  authenticate(req, (err, authInfo) => {
    if (err) {
      console.warn(`[auth] rejected: ${err.message}`);
      try {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
      } catch {
        /* ignore */
      }
      return;
    }
    console.log(`[auth] ok: user=${authInfo.username}, room=${authInfo.projectId}`);
    wss.handleUpgrade(req, socket, head, (conn) => {
      // 将 authInfo 附到连接上，供 awareness 展示
      conn.authInfo = authInfo;
      wss.emit('connection', conn, req);
    });
  });
});

wss.on('connection', (conn, req) => {
  setupWSConnection(conn, req, {
    docName: conn.authInfo.projectId,
    // gc: true  启用垃圾回收
  });
});

// 挂载同步播放 & 语音房间（各自注册对应路径的 upgrade 监听器）
createSyncPlayServer(server);
createVoiceRoomServer(server);

// 启动 5 分钟自动快照
snapshotManager.startAutoSnapshot();

server.listen(PORT, () => {
  console.log(`ScriptSync y-websocket server running on ws://localhost:${PORT}`);
  console.log(`  sync-play:  ws://localhost:${PORT}/sync-play/:projectId`);
  console.log(`  voice-room: ws://localhost:${PORT}/voice-room`);
  console.log(`  snapshot:   http://localhost:${PORT}/snapshot/:projectId`);
  console.log(`JWT secret: ${JWT_SECRET === 'scriptsync-dev-secret-change-in-prod' ? '⚠️  using default dev secret' : '✅ configured'}`);
});

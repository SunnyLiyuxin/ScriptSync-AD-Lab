/**
 * 同步播放 WebSocket 服务（独立于 Yjs，低延迟播放同步）
 *
 * 挂载方式：createSyncPlayServer(httpServer) —— 监听路径 /sync-play/:projectId
 * 协议：
 *   客户端→服务端：{ type:'join', userId, username }
 *                  { type:'play'|'pause'|'seek', currentTime:number }
 *   服务端→所有客户端：
 *                  { type:'play'|'pause'|'seek', currentTime, controllerId, controllerName, timestamp }
 *                  { type:'member-joined', userId, username }
 *                  { type:'member-left', userId }
 *                  { type:'members', members:[...], controllerId, controllerName }   // 发给加入者
 *                  { type:'controller', controllerId, controllerName }               // 主持人变更广播
 *
 * 主持人模式：首个加入者默认为主持人；也可通过 query 参数 ?controllerId=<userId> 指定。
 *            仅 controllerId 匹配的客户端可发 play/pause/seek 控制命令。
 */
import { WebSocketServer, WebSocket } from 'ws';

const SYNC_PLAY_PREFIX = '/sync-play/';

function safeSend(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    } catch {
      /* ignore single-conn send errors */
    }
  }
}

/**
 * @param {import('http').Server} httpServer
 * @returns {WebSocketServer}
 */
export function createSyncPlayServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  // projectId -> { controllerId, controllerName, clients: Map<ws, {userId, username}> }
  const rooms = new Map();

  function getRoom(projectId) {
    let room = rooms.get(projectId);
    if (!room) {
      room = { controllerId: null, controllerName: null, clients: new Map() };
      rooms.set(projectId, room);
    }
    return room;
  }

  function broadcast(room, message, excludeWs = null) {
    const data = JSON.stringify(message);
    for (const client of room.clients.keys()) {
      if (client === excludeWs) continue;
      safeSend(client, data);
    }
  }

  // 自行处理 /sync-play/ 前缀的 upgrade 请求
  httpServer.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      pathname = req.url ? req.url.split('?')[0] : '';
    }
    if (!pathname.startsWith(SYNC_PLAY_PREFIX)) return; // 不是本模块的路径，交给其它监听器

    let projectId = decodeURIComponent(pathname.slice(SYNC_PLAY_PREFIX.length));
    if (!projectId) projectId = 'default';

    let desiredControllerId = null;
    try {
      desiredControllerId = new URL(req.url, 'http://localhost').searchParams.get('controllerId');
    } catch {
      /* ignore */
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws._projectId = projectId;
      ws._desiredControllerId = desiredControllerId;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    const projectId = ws._projectId;
    const room = getRoom(projectId);
    ws._joined = false;
    ws._userId = null;
    ws._username = null;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // 非 JSON，忽略
      }
      if (!msg || typeof msg !== 'object') return;

      try {
        switch (msg.type) {
          case 'join': {
            const userId = String(msg.userId ?? '');
            const username = String(msg.username ?? '');
            if (!userId) return;

            ws._userId = userId;
            ws._username = username;
            ws._joined = true;
            room.clients.set(ws, { userId, username });

            // 主持人分配：房间无主持人则当前用户担任；
            // 若该用户与 query 指定的 controllerId 一致，则由其接管。
            if (!room.controllerId) {
              room.controllerId = userId;
              room.controllerName = username;
            } else if (ws._desiredControllerId && ws._desiredControllerId === userId) {
              room.controllerId = userId;
              room.controllerName = username;
            }

            // 向加入者发送当前成员列表 + 主持人
            const members = [...room.clients.values()].map((c) => ({
              userId: c.userId,
              username: c.username,
            }));
            safeSend(ws, {
              type: 'members',
              members,
              controllerId: room.controllerId,
              controllerName: room.controllerName,
            });

            // 广播成员加入 & 主持人信息
            broadcast(room, { type: 'member-joined', userId, username }, ws);
            broadcast(room, {
              type: 'controller',
              controllerId: room.controllerId,
              controllerName: room.controllerName,
            });
            break;
          }

          case 'play':
          case 'pause':
          case 'seek': {
            if (!ws._joined || !ws._userId) return;
            // 仅主持人可控制
            if (room.controllerId && ws._userId !== room.controllerId) return;
            const currentTime = Number(msg.currentTime);
            broadcast(room, {
              type: msg.type,
              currentTime: Number.isFinite(currentTime) ? currentTime : 0,
              controllerId: room.controllerId,
              controllerName: room.controllerName,
              timestamp: Date.now(),
            });
            break;
          }

          default:
            // 未知消息类型，忽略
            break;
        }
      } catch {
        // 单条消息处理异常不影响服务
      }
    });

    const cleanup = () => {
      try {
        if (ws._joined && ws._userId) {
          room.clients.delete(ws);
          broadcast(room, { type: 'member-left', userId: ws._userId });

          // 主持人离开则重新指派
          if (room.controllerId === ws._userId) {
            const next = [...room.clients.values()][0];
            if (next) {
              room.controllerId = next.userId;
              room.controllerName = next.username;
            } else {
              room.controllerId = null;
              room.controllerName = null;
            }
            broadcast(room, {
              type: 'controller',
              controllerId: room.controllerId,
              controllerName: room.controllerName,
            });
          }
        }
        if (room.clients.size === 0) rooms.delete(projectId);
      } catch {
        /* ignore cleanup errors */
      }
    };

    ws.on('close', cleanup);
    ws.on('error', () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  });

  return wss;
}

export default createSyncPlayServer;

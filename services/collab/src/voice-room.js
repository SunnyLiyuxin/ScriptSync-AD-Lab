/**
 * 语音房间信令服务（百炼多模态 WebSocket 的前置信令）
 *
 * 挂载方式：createVoiceRoomServer(httpServer) —— 监听路径 /voice-room
 *
 * 注意：本模块只做信令转发（房间管理 + WebRTC SDP/ICE 转发），
 *       实际音频流走 WebRTC P2P 或百炼多模态 WS。
 *
 * 消息格式：
 *   join:    { type:'join',    roomId, userId, username }
 *   leave:   { type:'leave',   roomId, userId }
 *   signal:  { type:'signal',  fromUserId, toUserId, data }   // 转发 SDP/ICE
 *   presenter:{ type:'presenter', roomId, userId }            // 设置当前念稿者
 *   mute:    { type:'mute',    userId, muted }
 *   speaking:{ type:'speaking', userId, isSpeaking }
 *
 * 服务端→客户端：
 *   { type:'members', roomId, members:[{userId,username,muted,isSpeaking}], presenter }
 *   { type:'member-joined', roomId, userId, username }
 *   { type:'member-left',   roomId, userId }
 *   { type:'signal', fromUserId, data }                         // 转发给目标用户
 *   { type:'presenter', roomId, userId }
 *   { type:'mute', userId, muted }
 *   { type:'speaking', userId, isSpeaking }
 */
import { WebSocketServer, WebSocket } from 'ws';

const VOICE_ROOM_PREFIX = '/voice-room';

function safeSend(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    } catch {
      /* ignore */
    }
  }
}

function isVoiceRoomPath(pathname) {
  return pathname === VOICE_ROOM_PREFIX || pathname.startsWith(VOICE_ROOM_PREFIX + '/');
}

/**
 * @param {import('http').Server} httpServer
 * @returns {WebSocketServer}
 */
export function createVoiceRoomServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  // roomId -> Map<userId, { ws, username, muted, isSpeaking }>
  const rooms = new Map();
  // roomId -> presenterUserId
  const presenters = new Map();

  function getRoom(roomId) {
    let room = rooms.get(roomId);
    if (!room) {
      room = new Map();
      rooms.set(roomId, room);
    }
    return room;
  }

  function broadcast(roomId, message, excludeWs = null) {
    const room = rooms.get(roomId);
    if (!room) return;
    const data = JSON.stringify(message);
    for (const { ws } of room.values()) {
      if (ws === excludeWs) continue;
      safeSend(ws, data);
    }
  }

  function membersList(roomId) {
    const room = rooms.get(roomId);
    if (!room) return [];
    return [...room.entries()].map(([userId, v]) => ({
      userId,
      username: v.username,
      muted: v.muted,
      isSpeaking: v.isSpeaking,
    }));
  }

  function leaveRoom(ws, roomId, userId) {
    const room = rooms.get(roomId);
    if (!room) return;
    const entry = room.get(userId);
    if (!entry || entry.ws !== ws) return; // 防止同一 userId 的旧连接误删新连接
    room.delete(userId);
    broadcast(roomId, { type: 'member-left', roomId, userId });

    if (presenters.get(roomId) === userId) {
      presenters.delete(roomId);
      broadcast(roomId, { type: 'presenter', roomId, userId: null });
    }

    if (room.size === 0) {
      rooms.delete(roomId);
      presenters.delete(roomId);
    }
  }

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      pathname = req.url ? req.url.split('?')[0] : '';
    }
    if (!isVoiceRoomPath(pathname)) return; // 非本模块路径

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    ws._roomId = null;
    ws._userId = null;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      try {
        switch (msg.type) {
          case 'join': {
            const roomId = String(msg.roomId ?? '');
            const userId = String(msg.userId ?? '');
            const username = String(msg.username ?? '');
            if (!roomId || !userId) return;

            // 若已在其它房间，先离开
            if (ws._roomId && ws._userId) {
              leaveRoom(ws, ws._roomId, ws._userId);
            }

            ws._roomId = roomId;
            ws._userId = userId;
            const room = getRoom(roomId);
            room.set(userId, { ws, username, muted: false, isSpeaking: false });

            // 向新成员发送当前房间成员列表 + 念稿者
            safeSend(ws, {
              type: 'members',
              roomId,
              members: membersList(roomId),
              presenter: presenters.get(roomId) || null,
            });
            // 广播成员加入
            broadcast(roomId, { type: 'member-joined', roomId, userId, username }, ws);
            break;
          }

          case 'leave': {
            const roomId = String(msg.roomId ?? ws._roomId ?? '');
            const userId = String(msg.userId ?? ws._userId ?? '');
            if (!roomId || !userId) return;
            leaveRoom(ws, roomId, userId);
            break;
          }

          case 'signal': {
            const toUserId = String(msg.toUserId ?? '');
            const fromUserId = String(msg.fromUserId ?? ws._userId ?? '');
            if (!ws._roomId || !toUserId) return;
            const room = rooms.get(ws._roomId);
            if (!room) return;
            const target = room.get(toUserId);
            if (!target) return;
            safeSend(target.ws, { type: 'signal', fromUserId, data: msg.data });
            break;
          }

          case 'presenter': {
            const roomId = String(msg.roomId ?? ws._roomId ?? '');
            const userId = String(msg.userId ?? '');
            if (!roomId || !userId) return;
            presenters.set(roomId, userId);
            broadcast(roomId, { type: 'presenter', roomId, userId });
            break;
          }

          case 'mute': {
            const userId = String(msg.userId ?? ws._userId ?? '');
            const muted = !!msg.muted;
            if (!ws._roomId) return;
            const room = rooms.get(ws._roomId);
            if (!room || !room.has(userId)) return;
            room.get(userId).muted = muted;
            broadcast(ws._roomId, { type: 'mute', userId, muted });
            break;
          }

          case 'speaking': {
            const userId = String(msg.userId ?? ws._userId ?? '');
            const isSpeaking = !!msg.isSpeaking;
            if (!ws._roomId) return;
            const room = rooms.get(ws._roomId);
            if (!room || !room.has(userId)) return;
            room.get(userId).isSpeaking = isSpeaking;
            broadcast(ws._roomId, { type: 'speaking', userId, isSpeaking });
            break;
          }

          default:
            break;
        }
      } catch {
        // 单条消息异常不影响服务
      }
    });

    ws.on('close', () => {
      try {
        if (ws._roomId && ws._userId) leaveRoom(ws, ws._roomId, ws._userId);
      } catch {
        /* ignore */
      }
    });

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

export default createVoiceRoomServer;

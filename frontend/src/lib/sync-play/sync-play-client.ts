/**
 * 同步播放客户端（V2）
 *
 * 连接后端 /sync-play/:projectId WebSocket，实现一人控制、众人跟随的播放同步。
 * 协议对齐 /workspace/services/collab/src/sync-play.js：
 *   客户端→服务端：{ type:'join', userId, username }
 *                  { type:'play'|'pause'|'seek', currentTime }
 *   服务端→客户端：
 *                  { type:'members', members, controllerId, controllerName }
 *                  { type:'member-joined', userId, username }
 *                  { type:'member-left', userId }
 *                  { type:'controller', controllerId, controllerName }
 *                  { type:'play'|'pause'|'seek', currentTime, controllerId, controllerName, timestamp }
 *
 * 主持人切换：服务端仅支持连接时通过 query ?controllerId=<userId> 指定，
 *            因此 requestControl() 通过带 query 重连实现。
 */
import type { SyncPlayState } from '../../types/project';

/** 同步播放房间成员 */
export interface SyncPlayMember {
  userId: string;
  username: string;
}

const DEFAULT_WS_URL = 'ws://localhost:1235';

function resolveWsBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_SYNC_WS_URL as string | undefined;
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_WS_URL;
}

type StateCallback = (state: SyncPlayState) => void;
type MembersCallback = (members: SyncPlayMember[]) => void;
type ControllerCallback = (controllerId: string | null, controllerName: string | null) => void;

export class SyncPlayClient {
  private ws: WebSocket | null = null;
  private baseUrl: string;
  private roomId = '';
  private userId = '';
  private username = '';

  private controllerId: string | null = null;
  private controllerName: string | null = null;
  private members: SyncPlayMember[] = [];

  private stateCallbacks = new Set<StateCallback>();
  private membersCallbacks = new Set<MembersCallback>();
  private controllerCallbacks = new Set<ControllerCallback>();

  /** 是否正在通过 requestControl 重连（避免重连时被当作断线） */
  private reconnectingAsController = false;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? resolveWsBaseUrl();
  }

  /** 当前用户是否为主持人 */
  get isController(): boolean {
    return this.controllerId !== null && this.controllerId === this.userId;
  }

  /** 当前主持人 ID */
  get currentControllerId(): string | null {
    return this.controllerId;
  }

  /** 当前主持人名称 */
  get currentControllerName(): string | null {
    return this.controllerName;
  }

  /** 是否已连接 */
  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * 连接同步播放房间
   * @param roomId    项目ID（路径参数）
   * @param userId    当前用户ID
   * @param username  当前用户名
   */
  connect(roomId: string, userId: string, username: string): void {
    // 已有连接则先关闭
    this.disconnectInternal(false);

    this.roomId = roomId;
    this.userId = userId;
    this.username = username;

    const url = `${this.baseUrl}/sync-play/${encodeURIComponent(roomId)}`;
    this.openSocket(url, false);
  }

  /** 断开连接 */
  disconnect(): void {
    this.disconnectInternal(true);
  }

  /** 播放（仅主持人可调用，服务端会再次校验） */
  play(currentTime: number): void {
    this.sendControl('play', currentTime);
  }

  /** 暂停（仅主持人可调用） */
  pause(currentTime: number): void {
    this.sendControl('pause', currentTime);
  }

  /** 跳转（仅主持人可调用） */
  seek(currentTime: number): void {
    this.sendControl('seek', currentTime);
  }

  /** 请求成为主持人：带 ?controllerId=<userId> 重连 */
  requestControl(): void {
    if (!this.roomId || !this.userId) return;
    if (this.isController) return;
    this.reconnectingAsController = true;
    this.disconnectInternal(false);
    const url = `${this.baseUrl}/sync-play/${encodeURIComponent(this.roomId)}?controllerId=${encodeURIComponent(this.userId)}`;
    this.openSocket(url, true);
  }

  /** 订阅服务端广播的播放状态变更 */
  onStateChange(callback: StateCallback): () => void {
    this.stateCallbacks.add(callback);
    return () => this.stateCallbacks.delete(callback);
  }

  /** 订阅成员列表变更 */
  onMembersChange(callback: MembersCallback): () => void {
    this.membersCallbacks.add(callback);
    return () => this.membersCallbacks.delete(callback);
  }

  /** 订阅主持人变更 */
  onControllerChange(callback: ControllerCallback): () => void {
    this.controllerCallbacks.add(callback);
    return () => this.controllerCallbacks.delete(callback);
  }

  // ===== 内部实现 =====

  private openSocket(url: string, asController: boolean): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.error('[SyncPlay] WebSocket 创建失败:', err);
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.safeSend(ws, { type: 'join', userId: this.userId, username: this.username });
      if (asController) {
        this.reconnectingAsController = false;
      }
    };

    ws.onmessage = (ev) => this.handleMessage(ev.data);

    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
    };

    ws.onerror = (err) => {
      console.error('[SyncPlay] WebSocket 错误:', err);
    };
  }

  private disconnectInternal(notify: boolean): void {
    if (this.ws) {
      try {
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.onmessage = null;
        this.ws.onopen = null;
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close();
        }
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    if (notify) {
      this.controllerId = null;
      this.controllerName = null;
      this.members = [];
    }
  }

  private sendControl(type: 'play' | 'pause' | 'seek', currentTime: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.isController) {
      console.warn('[SyncPlay] 非主持人无法发送控制命令');
      return;
    }
    this.safeSend(this.ws, { type, currentTime });
  }

  private handleMessage(raw: unknown): void {
    let msg: any;
    try {
      const text = typeof raw === 'string' ? raw : '';
      if (!text) return;
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'members': {
        const list = Array.isArray(msg.members) ? msg.members : [];
        this.members = list.map((m: any) => ({
          userId: String(m?.userId ?? ''),
          username: String(m?.username ?? ''),
        })).filter((m: SyncPlayMember) => m.userId.length > 0);
        this.controllerId = msg.controllerId ?? null;
        this.controllerName = msg.controllerName ?? null;
        this.emitMembers();
        this.emitController();
        break;
      }
      case 'member-joined': {
        const userId = String(msg.userId ?? '');
        const username = String(msg.username ?? '');
        if (!userId) break;
        if (!this.members.some(m => m.userId === userId)) {
          this.members = [...this.members, { userId, username }];
          this.emitMembers();
        }
        break;
      }
      case 'member-left': {
        const userId = String(msg.userId ?? '');
        if (!userId) break;
        this.members = this.members.filter(m => m.userId !== userId);
        this.emitMembers();
        break;
      }
      case 'controller': {
        this.controllerId = msg.controllerId ?? null;
        this.controllerName = msg.controllerName ?? null;
        this.emitController();
        break;
      }
      case 'play':
      case 'pause':
      case 'seek': {
        const state: SyncPlayState = {
          type: msg.type,
          currentTime: Number(msg.currentTime ?? 0),
          controllerId: String(msg.controllerId ?? ''),
          controllerName: String(msg.controllerName ?? ''),
          timestamp: Number(msg.timestamp ?? Date.now()),
        };
        // 同步本地 controller 信息
        if (msg.controllerId) {
          this.controllerId = String(msg.controllerId);
          this.controllerName = String(msg.controllerName ?? this.controllerName);
        }
        this.emitState(state);
        break;
      }
      default:
        break;
    }
  }

  private emitState(state: SyncPlayState): void {
    for (const cb of this.stateCallbacks) {
      try { cb(state); } catch { /* ignore */ }
    }
  }

  private emitMembers(): void {
    for (const cb of this.membersCallbacks) {
      try { cb([...this.members]); } catch { /* ignore */ }
    }
  }

  private emitController(): void {
    for (const cb of this.controllerCallbacks) {
      try { cb(this.controllerId, this.controllerName); } catch { /* ignore */ }
    }
  }

  private safeSend(ws: WebSocket, data: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    } catch {
      /* ignore */
    }
  }
}

export default SyncPlayClient;

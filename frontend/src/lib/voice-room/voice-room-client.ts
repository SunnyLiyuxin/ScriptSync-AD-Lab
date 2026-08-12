/**
 * 语音房间客户端（V2）
 *
 * 基于 WebRTC 的语音房间客户端，mesh 拓扑（MVP 够用）。
 * 信令走后端 /voice-room WebSocket，对齐
 * /workspace/services/collab/src/voice-room.js：
 *
 *   客户端→服务端：
 *     { type:'join',     roomId, userId, username }
 *     { type:'leave',    roomId, userId }
 *     { type:'signal',   fromUserId, toUserId, data }   // 转发 SDP/ICE
 *     { type:'presenter', roomId, userId }
 *     { type:'mute',     userId, muted }
 *     { type:'speaking', userId, isSpeaking }
 *
 *   服务端→客户端：
 *     { type:'members', roomId, members:[{userId,username,muted,isSpeaking}], presenter }
 *     { type:'member-joined', roomId, userId, username }
 *     { type:'member-left',   roomId, userId }
 *     { type:'signal', fromUserId, data }
 *     { type:'presenter', roomId, userId }
 *     { type:'mute', userId, muted }
 *     { type:'speaking', userId, isSpeaking }
 *
 * WebRTC 默认不用 STUN/TURN（局域网/MVP），可通过构造参数 iceServers 配置。
 */
import type { VoiceRoomMember } from '../../types/project';

type MemberUpdateCallback = (members: VoiceRoomMember[]) => void;
type AudioStreamCallback = (userId: string, stream: MediaStream) => void;
type PresenterChangeCallback = (presenterId: string | null) => void;
type ErrorCallback = (error: Error) => void;

/** 信令数据：SDP 或 ICE */
interface SignalData {
  sdp?: RTCSessionDescriptionInit;
  ice?: RTCIceCandidateInit;
}

/** 单个远端对等连接的上下文 */
interface PeerEntry {
  pc: RTCPeerConnection;
  stream: MediaStream;
  /** 是否已由本端发起过 offer（避免重复 negotiation） */
  initiator: boolean;
}

const DEFAULT_WS_URL = 'ws://localhost:1235';

function resolveWsBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_SYNC_WS_URL as string | undefined;
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_WS_URL;
}

export class VoiceRoomClient {
  private ws: WebSocket | null = null;
  private baseUrl: string;
  private iceServers: RTCIceServer[];

  private roomId = '';
  private userId = '';
  private username = '';

  private localStream: MediaStream | null = null;
  private localAudioTrackEnabled = true;

  /** 远端对等连接表 */
  private peers = new Map<string, PeerEntry>();

  /** 当前房间成员（含本地，便于 UI 展示完整列表） */
  private members: VoiceRoomMember[] = [];
  private presenterId: string | null = null;

  /** 自己的静音状态 */
  private muted = false;

  /** 说话检测：避免频繁广播 */
  private speaking = false;
  private speakingAnalyser: AnalyserNode | null = null;
  private speakingAudioCtx: AudioContext | null = null;
  private speakingRaf = 0;
  private speakingLastSent = 0;

  private memberCallbacks = new Set<MemberUpdateCallback>();
  private audioCallbacks = new Set<AudioStreamCallback>();
  private presenterCallbacks = new Set<PresenterChangeCallback>();
  private errorCallbacks = new Set<ErrorCallback>();

  constructor(opts?: { baseUrl?: string; iceServers?: RTCIceServer[] }) {
    this.baseUrl = opts?.baseUrl ?? resolveWsBaseUrl();
    this.iceServers = opts?.iceServers ?? [];
  }

  /** 当前念稿者 */
  get currentPresenterId(): string | null {
    return this.presenterId;
  }

  /** 自己是否被静音 */
  get isMuted(): boolean {
    return this.muted;
  }

  /** 本地麦克风流（供录音等场景复用，避免重复采集） */
  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  /** 是否已加入房间 */
  get joined(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.roomId.length > 0;
  }

  /**
   * 加入语音房间
   * @throws 麦克风权限拒绝 / WebRTC 不支持
   */
  async join(roomId: string, userId: string, username: string): Promise<void> {
    if (typeof RTCPeerConnection === 'undefined') {
      throw new Error('当前浏览器不支持 WebRTC，无法加入语音房间');
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('当前浏览器不支持麦克风采集，无法加入语音房间');
    }

    // 已在房间则先退出
    if (this.joined) {
      this.leave();
    }

    this.roomId = roomId;
    this.userId = userId;
    this.username = username;
    this.muted = false;
    this.speaking = false;

    // 1. 获取本地麦克风
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/Permission|NotAllowed|denied/i.test(msg)) {
        throw new Error('麦克风权限被拒绝，请在浏览器设置中允许访问麦克风');
      }
      throw new Error(`获取麦克风失败: ${msg}`);
    }

    // 2. 连接信令 WebSocket
    const url = `${this.baseUrl}/voice-room`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.cleanupLocalStream();
      throw new Error(`信令连接失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.ws = ws;

    ws.onopen = () => {
      this.safeSend(ws, { type: 'join', roomId: this.roomId, userId: this.userId, username: this.username });
      this.startSpeakingDetection();
    };
    ws.onmessage = (ev) => this.handleMessage(ev.data);
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
    };
    ws.onerror = () => {
      this.emitError(new Error('语音房间信令连接出错'));
    };

    // 等待连接建立（最多 5s）
    await new Promise<void>((resolve, reject) => {
      if (ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        reject(new Error('语音房间信令连接超时'));
      }, 5000);
      const onOpen = () => {
        clearTimeout(timer);
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
        resolve();
      };
      const onError = () => {
        clearTimeout(timer);
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
        reject(new Error('语音房间信令连接失败'));
      };
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
    });
  }

  /** 离开房间 */
  leave(): void {
    // 关闭所有对等连接
    for (const [id, entry] of this.peers.entries()) {
      try {
        entry.pc.close();
      } catch {
        /* ignore */
      }
      this.peers.delete(id);
    }
    // 停止说话检测
    this.stopSpeakingDetection();
    // 清理本地流
    this.cleanupLocalStream();
    // 发送 leave 并关闭信令
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.safeSend(this.ws, { type: 'leave', roomId: this.roomId, userId: this.userId });
        }
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.onmessage = null;
        this.ws.onopen = null;
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.members = [];
    this.presenterId = null;
    this.muted = false;
    this.speaking = false;
    this.emitMembers();
    this.emitPresenter(this.presenterId);
  }

  /** 切换本地麦克风静音状态，返回新的静音状态 */
  toggleMute(): boolean {
    if (!this.localStream) return this.muted;
    this.muted = !this.muted;
    for (const track of this.localStream.getAudioTracks()) {
      track.enabled = !this.muted;
    }
    this.localAudioTrackEnabled = !this.muted;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.safeSend(this.ws, { type: 'mute', userId: this.userId, muted: this.muted });
    }
    // 同步本地成员状态
    this.members = this.members.map(m =>
      m.userId === this.userId ? { ...m, muted: this.muted } : m,
    );
    this.emitMembers();
    return this.muted;
  }

  /** 设置当前念稿者 */
  setPresenter(targetUserId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.safeSend(this.ws, { type: 'presenter', roomId: this.roomId, userId: targetUserId });
  }

  /** 订阅成员列表变更 */
  onMemberUpdate(callback: MemberUpdateCallback): () => void {
    this.memberCallbacks.add(callback);
    return () => this.memberCallbacks.delete(callback);
  }

  /** 订阅远端音频流 */
  onAudioStream(callback: AudioStreamCallback): () => void {
    this.audioCallbacks.add(callback);
    return () => this.audioCallbacks.delete(callback);
  }

  /** 订阅念稿者变更 */
  onPresenterChange(callback: PresenterChangeCallback): () => void {
    this.presenterCallbacks.add(callback);
    return () => this.presenterCallbacks.delete(callback);
  }

  /** 订阅错误事件 */
  onError(callback: ErrorCallback): () => void {
    this.errorCallbacks.add(callback);
    return () => this.errorCallbacks.delete(callback);
  }

  // ===== 信令处理 =====

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
        this.presenterId = msg.presenter ?? null;
        this.members = this.normalizeMembers(list);
        this.emitMembers();
        this.emitPresenter(this.presenterId);
        // 与已有成员建立 WebRTC（本端为新加入者，主动发起）
        for (const m of this.members) {
          if (m.userId !== this.userId) {
            this.initiatePeer(m.userId);
          }
        }
        break;
      }
      case 'member-joined': {
        const userId = String(msg.userId ?? '');
        const username = String(msg.username ?? '');
        if (!userId || userId === this.userId) break;
        if (!this.members.some(m => m.userId === userId)) {
          this.members = [...this.members, {
            userId, username, muted: false, isSpeaking: false,
            isPresenter: this.presenterId === userId, joinedAt: Date.now(),
          }];
          this.emitMembers();
        }
        // 不主动发起连接：由新加入者主动发起（避免 glare）
        break;
      }
      case 'member-left': {
        const userId = String(msg.userId ?? '');
        if (!userId) break;
        this.removePeer(userId);
        this.members = this.members.filter(m => m.userId !== userId);
        if (this.presenterId === userId) {
          this.presenterId = null;
          this.emitPresenter(null);
        }
        this.emitMembers();
        break;
      }
      case 'signal': {
        const fromUserId = String(msg.fromUserId ?? '');
        if (!fromUserId || fromUserId === this.userId) break;
        this.handleSignal(fromUserId, msg.data as SignalData);
        break;
      }
      case 'presenter': {
        const userId = msg.userId ?? null;
        this.presenterId = userId ? String(userId) : null;
        this.members = this.members.map(m => ({ ...m, isPresenter: m.userId === this.presenterId }));
        this.emitMembers();
        this.emitPresenter(this.presenterId);
        break;
      }
      case 'mute': {
        const userId = String(msg.userId ?? '');
        const muted = !!msg.muted;
        this.members = this.members.map(m =>
          m.userId === userId ? { ...m, muted } : m,
        );
        this.emitMembers();
        break;
      }
      case 'speaking': {
        const userId = String(msg.userId ?? '');
        const isSpeaking = !!msg.isSpeaking;
        this.members = this.members.map(m =>
          m.userId === userId ? { ...m, isSpeaking } : m,
        );
        this.emitMembers();
        break;
      }
      default:
        break;
    }
  }

  private normalizeMembers(list: any[]): VoiceRoomMember[] {
    const result: VoiceRoomMember[] = list.map((m: any) => ({
      userId: String(m?.userId ?? ''),
      username: String(m?.username ?? ''),
      muted: !!m?.muted,
      isSpeaking: !!m?.isSpeaking,
      isPresenter: this.presenterId === String(m?.userId ?? ''),
      joinedAt: Number(m?.joinedAt ?? Date.now()),
    })).filter(m => m.userId.length > 0);

    // 确保本端自身也在列表里
    if (!result.some(m => m.userId === this.userId)) {
      result.unshift({
        userId: this.userId,
        username: this.username,
        muted: this.muted,
        isSpeaking: this.speaking,
        isPresenter: this.presenterId === this.userId,
        joinedAt: Date.now(),
      });
    }
    return result;
  }

  // ===== WebRTC =====

  /** 主动向某成员发起 WebRTC 连接（作为发起方） */
  private initiatePeer(remoteUserId: string): void {
    if (this.peers.has(remoteUserId)) return;
    if (!this.localStream) return;
    const entry = this.createPeerConnection(remoteUserId, true);
    if (!entry) return;
    // negotiationneeded 事件会触发 offer 创建
  }

  /** 创建 RTCPeerConnection 并挂载本地轨道 */
  private createPeerConnection(remoteUserId: string, initiator: boolean): PeerEntry | null {
    try {
      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      const stream = new MediaStream();

      // 添加本地音频轨道
      if (this.localStream) {
        for (const track of this.localStream.getAudioTracks()) {
          pc.addTrack(track, this.localStream);
        }
      }

      // 收到远端轨道
      pc.ontrack = (event) => {
        for (const track of event.streams[0]?.getTracks() ?? [event.track]) {
          stream.addTrack(track);
        }
        // 通知上层
        for (const cb of this.audioCallbacks) {
          try { cb(remoteUserId, stream); } catch { /* ignore */ }
        }
      };

      // ICE 候选
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          this.sendSignal(remoteUserId, { ice: event.candidate.toJSON() });
        }
      };

      // 连接断开清理
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          // failed 时尝试关闭，由 member-left 或后续重连处理
          if (pc.connectionState === 'failed') {
            this.emitError(new Error(`与 ${remoteUserId} 的语音连接失败`));
          }
        }
      };

      // 发起方：触发 negotiationneeded 后创建 offer
      pc.onnegotiationneeded = () => {
        if (!this.peers.has(remoteUserId)) return;
        const cur = this.peers.get(remoteUserId);
        if (!cur || !cur.initiator) return;
        void this.createAndSendOffer(remoteUserId, pc);
      };

      const entry: PeerEntry = { pc, stream, initiator };
      this.peers.set(remoteUserId, entry);
      return entry;
    } catch (err) {
      this.emitError(new Error(`创建 WebRTC 连接失败: ${err instanceof Error ? err.message : String(err)}`));
      return null;
    }
  }

  private async createAndSendOffer(remoteUserId: string, pc: RTCPeerConnection): Promise<void> {
    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      this.sendSignal(remoteUserId, { sdp: pc.localDescription?.toJSON() });
    } catch (err) {
      this.emitError(new Error(`创建 offer 失败: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  private async handleSignal(fromUserId: string, data: SignalData): Promise<void> {
    if (!data) return;
    let entry = this.peers.get(fromUserId);
    if (!entry) {
      // 收到对方发起的 offer，本端作为响应方创建连接
      const created = this.createPeerConnection(fromUserId, false);
      if (!created) return;
      entry = created;
    }
    const pc = entry.pc;
    try {
      if (data.sdp) {
        const sdp = data.sdp as RTCSessionDescriptionInit;
        // 公共类型上 RTCSessionDescriptionInit 没有 type 字段，但运行时有
        const desc = new RTCSessionDescription(sdp as RTCSessionDescriptionInit);
        await pc.setRemoteDescription(desc);
        if (desc.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.sendSignal(fromUserId, { sdp: pc.localDescription?.toJSON() });
        }
      } else if (data.ice) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(data.ice as RTCIceCandidateInit));
        } catch (err) {
          // 忽略早到的候选（remoteDescription 还没设好）
          console.warn('[VoiceRoom] addIceCandidate 失败:', err);
        }
      }
    } catch (err) {
      this.emitError(new Error(`处理信令失败: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  private sendSignal(toUserId: string, data: SignalData): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.safeSend(this.ws, {
      type: 'signal',
      fromUserId: this.userId,
      toUserId,
      data,
    });
  }

  private removePeer(remoteUserId: string): void {
    const entry = this.peers.get(remoteUserId);
    if (!entry) return;
    try { entry.pc.close(); } catch { /* ignore */ }
    this.peers.delete(remoteUserId);
  }

  // ===== 说话检测 =====

  private startSpeakingDetection(): void {
    if (!this.localStream) return;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      this.speakingAudioCtx = new AudioCtx();
      const source = this.speakingAudioCtx.createMediaStreamSource(this.localStream);
      const analyser = this.speakingAudioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      this.speakingAnalyser = analyser;
      this.loopSpeakingDetection();
    } catch {
      /* 检测失败不影响主流程 */
    }
  }

  private loopSpeakingDetection = (): void => {
    if (!this.speakingAnalyser) return;
    const data = new Uint8Array(this.speakingAnalyser.frequencyBinCount);
    this.speakingAnalyser.getByteFrequencyData(data);
    // 简单能量平均
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    const avg = sum / data.length;
    const threshold = 18; // 经验值
    const nowSpeaking = avg > threshold && !this.muted;

    const now = Date.now();
    if (nowSpeaking !== this.speaking && now - this.speakingLastSent > 250) {
      this.speaking = nowSpeaking;
      this.speakingLastSent = now;
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.safeSend(this.ws, { type: 'speaking', userId: this.userId, isSpeaking: nowSpeaking });
      }
      // 同步本地成员
      this.members = this.members.map(m =>
        m.userId === this.userId ? { ...m, isSpeaking: nowSpeaking } : m,
      );
      this.emitMembers();
    }
    this.speakingRaf = requestAnimationFrame(this.loopSpeakingDetection);
  };

  private stopSpeakingDetection(): void {
    if (this.speakingRaf) {
      cancelAnimationFrame(this.speakingRaf);
      this.speakingRaf = 0;
    }
    if (this.speakingAnalyser) {
      this.speakingAnalyser = null;
    }
    if (this.speakingAudioCtx) {
      try { this.speakingAudioCtx.close(); } catch { /* ignore */ }
      this.speakingAudioCtx = null;
    }
  }

  // ===== 辅助 =====

  private cleanupLocalStream(): void {
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        try { track.stop(); } catch { /* ignore */ }
      }
      this.localStream = null;
    }
  }

  private emitMembers(): void {
    const snapshot = [...this.members];
    for (const cb of this.memberCallbacks) {
      try { cb(snapshot); } catch { /* ignore */ }
    }
  }

  private emitPresenter(presenterId: string | null): void {
    for (const cb of this.presenterCallbacks) {
      try { cb(presenterId); } catch { /* ignore */ }
    }
  }

  private emitError(err: Error): void {
    for (const cb of this.errorCallbacks) {
      try { cb(err); } catch { /* ignore */ }
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

export default VoiceRoomClient;

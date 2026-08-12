<script lang="ts">
  /**
   * 演练模式组件（V2）
   * 整合语音房间 + 同步播放 + 提词器的口述演练模式。
   *
   * - 开始演练：连接语音房间 + 同步播放（当前用户默认为主持人/念稿者）+ 显示提词器
   * - 念稿者：控制视频播放（同步播放广播）、提词器跟随
   * - 旁听者：跟随念稿者播放状态、可静音自己
   * - 录音：MediaRecorder 录制本地麦克风 + 视频音频混音
   * - 录音上传：POST /api/projects/{projectId}/rehearsal-recording (FormData)
   * - 时长实测：录制结束后展示每条字幕的实际念稿时长 vs 预估时长
   */
  import { onDestroy } from 'svelte';
  import * as Y from 'yjs';
  import type { WebsocketProvider } from 'y-websocket';
  import type { AssEvent } from '../types/ass';
  import type { SyncPlayState, VoiceRoomMember } from '../types/project';
  import { stripAllTags } from '../lib/ass/tag-parser';
  import { formatDisplayTime } from '../lib/ass/time-utils';
  import SyncPlayClient from '../lib/sync-play/sync-play-client';
  import VoiceRoomClient from '../lib/voice-room/voice-room-client';
  import Teleprompter from './Teleprompter.svelte';

  /** VideoPlayer 暴露的实例方法（结构化类型，与 VideoPlayer.svelte 兼容） */
  interface VideoPlayerHandle {
    play(): void;
    pause(): void;
    seekTo(t: number): void;
    getCurrentTime(): number;
  }

  interface Props {
    doc: Y.Doc;
    provider: WebsocketProvider;
    videoPlayer: VideoPlayerHandle | null;
    projectId: string;
    userId: string;
    username: string;
    events: AssEvent[];
    currentTime: number;
    authToken: string;
  }

  let {
    doc,
    provider,
    videoPlayer,
    projectId,
    userId,
    username,
    events,
    currentTime,
    authToken,
  }: Props = $props();

  // doc / provider 当前由父组件管理 Yjs 文档；演练态用独立 WS 通道，
  // 此处保留引用供后续扩展（如 awareness 同步演练状态）
  void doc;
  void provider;

  // ===== 演练状态 =====
  let active = $state(false);
  let connecting = $state(false);
  let error = $state<string | null>(null);

  let voiceClient: VoiceRoomClient | null = null;
  let syncClient: SyncPlayClient | null = null;

  let members = $state<VoiceRoomMember[]>([]);
  let presenterId = $state<string | null>(null);
  let isController = $state(false);
  let syncConnected = $state(false);

  // ===== 录音 =====
  let recording = $state(false);
  let mediaRecorder: MediaRecorder | null = null;
  let recordedChunks: Blob[] = [];
  let recordingStartTime = 0;
  let recordingDuration = $state(0);
  let recordingStatus = $state('');
  let recordingMime = 'audio/webm';
  let recordingAudioCtx: AudioContext | null = null;
  let recordingMicStream: MediaStream | null = null;

  // ===== 时长实测 =====
  /** eventId -> 实际念稿累计秒数（响应式，供 UI 展示） */
  let durationsDisplay = $state<Record<string, number>>({});
  /** 累加器（非响应式，避免 effect 循环） */
  const durationsAccumulator: Record<string, number> = {};
  /** 上次 tick 的 currentTime（非响应式） */
  let lastTickTime = 0;
  let showDurationReport = $state(false);

  // ===== 清理 =====
  let unsubVoice: (() => void) | null = null;
  let unsubVoiceAudio: (() => void) | null = null;
  let unsubPresenter: (() => void) | null = null;
  let unsubVoiceErr: (() => void) | null = null;
  let unsubSyncState: (() => void) | null = null;
  let unsubSyncMembers: (() => void) | null = null;
  let unsubSyncCtrl: (() => void) | null = null;

  onDestroy(() => stopRehearsal());

  // ===== 时长累计 effect =====
  // 每次 currentTime 变化时，将时间增量累加到对应字幕条目
  $effect(() => {
    const t = currentTime;
    if (!active) {
      lastTickTime = 0;
      return;
    }
    if (lastTickTime > 0) {
      const dt = t - lastTickTime;
      // 仅累加正常播放的小增量（0~1s），跳过 seek 跳转
      if (dt > 0 && dt < 1) {
        const mid = (t + lastTickTime) / 2;
        const ev = events.find(
          e => mid >= e.start && mid < e.end && e._status !== 'deleted',
        );
        if (ev) {
          durationsAccumulator[ev.id] = (durationsAccumulator[ev.id] ?? 0) + dt;
          durationsDisplay = { ...durationsAccumulator };
        }
      }
    }
    lastTickTime = t;
  });

  // ===== 时长实测报告 =====
  interface DurationRow {
    event: AssEvent;
    estimated: number;
    actual: number;
    cleanText: string;
    overTime: boolean;
  }

  let durationReport = $derived.by<DurationRow[]>(() => {
    void durationsDisplay; // 响应式依赖
    return events
      .filter(e => e._status !== 'deleted')
      .map(e => {
        const cleanText = stripAllTags(e.text);
        const estimated = cleanText.length / 3.5;
        const actual = durationsDisplay[e.id] ?? 0;
        return {
          event: e,
          estimated,
          actual,
          cleanText,
          overTime: actual > 0 && estimated > 0 && actual > estimated * 1.3,
        };
      })
      .filter(r => r.actual > 0.05);
  });

  // ===== 开始 / 结束演练 =====
  async function startRehearsal() {
    error = null;
    connecting = true;
    // 清空时长累计
    Object.keys(durationsAccumulator).forEach(k => delete durationsAccumulator[k]);
    durationsDisplay = {};
    showDurationReport = false;

    try {
      // 1. 语音房间
      voiceClient = new VoiceRoomClient();
      unsubVoice = voiceClient.onMemberUpdate(m => { members = m; });
      unsubPresenter = voiceClient.onPresenterChange(p => { presenterId = p; });
      unsubVoiceErr = voiceClient.onError(e => { error = e.message; });
      // 远端音频流回调（MVP 下不强制播放，避免自动播放策略限制；上层可按需处理）
      unsubVoiceAudio = voiceClient.onAudioStream((_uid, _stream) => { /* 预留 */ });
      await voiceClient.join(projectId, userId, username);
      // 自己默认为念稿者
      voiceClient.setPresenter(userId);

      // 2. 同步播放
      syncClient = new SyncPlayClient();
      syncClient.connect(projectId, userId, username);
      // 请求成为主持人（带 ?controllerId 重连）
      syncClient.requestControl();

      unsubSyncState = syncClient.onStateChange(handleSyncStateChange);
      unsubSyncMembers = syncClient.onMembersChange(() => { syncConnected = true; });
      unsubSyncCtrl = syncClient.onControllerChange((cid) => {
        isController = cid === userId;
      });

      active = true;
      lastTickTime = currentTime;
    } catch (e: any) {
      error = e?.message || '连接失败';
      stopRehearsal();
    } finally {
      connecting = false;
    }
  }

  function stopRehearsal() {
    if (recording) {
      stopRecording();
    }
    unsubVoice?.(); unsubVoice = null;
    unsubVoiceAudio?.(); unsubVoiceAudio = null;
    unsubPresenter?.(); unsubPresenter = null;
    unsubVoiceErr?.(); unsubVoiceErr = null;
    unsubSyncState?.(); unsubSyncState = null;
    unsubSyncMembers?.(); unsubSyncMembers = null;
    unsubSyncCtrl?.(); unsubSyncCtrl = null;
    try { voiceClient?.leave(); } catch { /* ignore */ }
    try { syncClient?.disconnect(); } catch { /* ignore */ }
    voiceClient = null;
    syncClient = null;
    active = false;
    members = [];
    presenterId = null;
    isController = false;
    syncConnected = false;
    lastTickTime = 0;
  }

  // ===== 同步播放状态处理（旁听者侧） =====
  function handleSyncStateChange(state: SyncPlayState) {
    if (!videoPlayer) return;
    // 忽略自己广播出去的状态
    if (state.controllerId === userId) return;
    if (state.type === 'play') {
      videoPlayer.seekTo(state.currentTime);
      videoPlayer.play();
    } else if (state.type === 'pause') {
      videoPlayer.seekTo(state.currentTime);
      videoPlayer.pause();
    } else if (state.type === 'seek') {
      videoPlayer.seekTo(state.currentTime);
    }
  }

  // ===== 念稿者播放控制 =====
  function presenterPlay() {
    if (!videoPlayer || !syncClient || !isController) return;
    videoPlayer.play();
    syncClient.play(videoPlayer.getCurrentTime());
  }
  function presenterPause() {
    if (!videoPlayer || !syncClient || !isController) return;
    videoPlayer.pause();
    syncClient.pause(videoPlayer.getCurrentTime());
  }
  function presenterSeek(delta: number) {
    if (!videoPlayer || !syncClient || !isController) return;
    const t = Math.max(0, videoPlayer.getCurrentTime() + delta);
    videoPlayer.seekTo(t);
    syncClient.seek(t);
  }

  /** 请求成为念稿者/主持人 */
  function requestPresenterRole() {
    voiceClient?.setPresenter(userId);
    syncClient?.requestControl();
  }

  function toggleMute() {
    voiceClient?.toggleMute();
    // 触发成员列表刷新（toggleMute 内部已更新并 emit）
  }

  let myMember = $derived(members.find(m => m.userId === userId) ?? null);
  let iAmPresenter = $derived(presenterId === userId);

  // ===== 录音 =====
  async function startRecording() {
    error = null;
    recordingStatus = '准备录制...';
    try {
      // 优先复用语音房间的本地麦克风流，避免重复采集
      let micStream = voiceClient?.getLocalStream() ?? null;
      if (!micStream) {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      }
      recordingMicStream = micStream;

      // 尝试混入视频音频
      let mixedStream: MediaStream = micStream;
      const videoEl = document.querySelector('video');
      if (videoEl) {
        try {
          const v = videoEl as HTMLVideoElement & {
            captureStream?: () => MediaStream;
            mozCaptureStream?: () => MediaStream;
          };
          const captureStream = v.captureStream ? v.captureStream() : v.mozCaptureStream?.();
          const videoAudioTracks = captureStream?.getAudioTracks() ?? [];
          if (videoAudioTracks.length > 0) {
            const AudioCtor: typeof AudioContext =
              window.AudioContext || (window as any).webkitAudioContext;
            const audioCtx = new AudioCtor();
            const dest = audioCtx.createMediaStreamDestination();
            audioCtx.createMediaStreamSource(micStream).connect(dest);
            audioCtx.createMediaStreamSource(new MediaStream(videoAudioTracks)).connect(dest);
            mixedStream = dest.stream;
            recordingAudioCtx = audioCtx;
          }
        } catch {
          /* 混音失败，使用纯麦克风 */
        }
      }

      const mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
      recordingMime = mimeCandidates.find(m => MediaRecorder.isTypeSupported(m)) || '';
      const options = recordingMime ? { mimeType: recordingMime } : undefined;
      mediaRecorder = new MediaRecorder(mixedStream, options);
      recordedChunks = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunks.push(e.data);
      };
      mediaRecorder.onstop = () => {
        const blob = new Blob(recordedChunks, { type: recordingMime || 'audio/webm' });
        const duration = (Date.now() - recordingStartTime) / 1000;
        recordingDuration = duration;
        void uploadRecording(blob, duration);
        // 清理音频上下文（不停止语音房间复用的 mic 轨道）
        if (recordingAudioCtx) {
          recordingAudioCtx.close().catch(() => {});
          recordingAudioCtx = null;
        }
        recordingMicStream = null;
        showDurationReport = true;
      };
      mediaRecorder.start(1000);
      recordingStartTime = Date.now();
      recording = true;
      recordingStatus = '录制中...';
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (/Permission|NotAllowed|denied/i.test(msg)) {
        error = '麦克风权限被拒绝，无法录制';
      } else {
        error = `录制启动失败: ${msg}`;
      }
      recordingStatus = '';
      recording = false;
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try { mediaRecorder.stop(); } catch { /* ignore */ }
    }
    recording = false;
    recordingStatus = '录制结束，正在上传...';
  }

  async function uploadRecording(blob: Blob, duration: number) {
    try {
      const formData = new FormData();
      const ext = recordingMime.includes('ogg') ? 'ogg' : 'webm';
      formData.append('recording', blob, `rehearsal-${projectId}-${Date.now()}.${ext}`);
      formData.append('projectId', projectId);
      formData.append('userId', userId);
      formData.append('username', username);
      formData.append('duration', String(duration));

      const res = await fetch(`/api/projects/${projectId}/rehearsal-recording`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
        body: formData,
      });
      if (!res.ok) throw new Error(`上传失败: HTTP ${res.status}`);
      recordingStatus = `上传完成（时长 ${duration.toFixed(1)}s）`;
    } catch (e: any) {
      recordingStatus = `上传失败: ${e?.message || String(e)}`;
    }
  }

  // ===== 成员显示 =====
  function memberLabel(m: VoiceRoomMember): string {
    if (m.userId === userId) return `${m.username}（我）`;
    return m.username;
  }
</script>

<div class="rehearsal-mode">
  <!-- 顶部控制条 -->
  <div class="control-bar">
    <div class="control-left">
      {#if !active}
        <button class="btn btn-primary" on:click={startRehearsal} disabled={connecting}>
          {connecting ? '连接中...' : '🎬 开始演练'}
        </button>
      {:else}
        <button class="btn btn-danger" on:click={stopRehearsal}>
          ⏹ 结束演练
        </button>
        <span class="status-dot active">演练中</span>
        {#if syncConnected}
          <span class="status-dot sync">同步播放已连接</span>
        {/if}
      {/if}
    </div>

    <div class="control-right">
      {#if active}
        {#if recording}
          <button class="btn btn-recording" on:click={stopRecording}>
            ⏺ 录制中... 点击停止
          </button>
        {:else}
          <button class="btn btn-record" on:click={startRecording}>
            ⏺ 开始录音
          </button>
        {/if}
      {/if}
    </div>
  </div>

  {#if error}
    <div class="error-banner">{error}</div>
  {/if}

  {#if recordingStatus}
    <div class="recording-status">{recordingStatus}</div>
  {/if}

  {#if !active && !connecting}
    <div class="idle-panel">
      <div class="idle-icon">🎬</div>
      <div class="idle-title">演练模式</div>
      <div class="idle-desc">
        点击「开始演练」进入口述演练模式。<br />
        系统将连接语音房间与同步播放，当前用户默认为主持人（念稿者）。<br />
        念稿者控制视频播放，旁听者自动跟随；可录制演练过程并查看时长实测。
      </div>
    </div>
  {/if}

  {#if active}
    <div class="rehearsal-layout">
      <!-- 左侧：提词器 -->
      <div class="teleprompter-area">
        <Teleprompter
          {events}
          {currentTime}
          {presenterId}
          {userId}
        />
      </div>

      <!-- 右侧：成员 + 控制 -->
      <div class="side-panel">
        <!-- 角色 / 控制权 -->
        <div class="panel-section">
          <div class="section-title">我的角色</div>
          {#if iAmPresenter}
            <div class="role-badge presenter">🎙 念稿者（主持人）</div>
            <div class="control-hint">你拥有视频播放控制权</div>
          {:else}
            <div class="role-badge audience">🎧 旁听者</div>
            <div class="control-hint">跟随念稿者的播放状态</div>
            <button class="btn btn-secondary small" on:click={requestPresenterRole}>
              请求成为念稿者
            </button>
          {/if}
        </div>

        <!-- 播放控制（念稿者） -->
        {#if iAmPresenter && videoPlayer}
          <div class="panel-section">
            <div class="section-title">播放控制</div>
            <div class="play-controls">
              <button class="btn btn-secondary" on:click={() => presenterSeek(-5)}>⏪ 5s</button>
              <button class="btn btn-primary" on:click={presenterPlay}>▶ 播放</button>
              <button class="btn btn-primary" on:click={presenterPause}>⏸ 暂停</button>
              <button class="btn btn-secondary" on:click={() => presenterSeek(5)}>5s ⏩</button>
            </div>
            <div class="current-time">{formatDisplayTime(currentTime)}</div>
          </div>
        {:else if active && videoPlayer}
          <div class="panel-section">
            <div class="section-title">播放状态</div>
            <div class="current-time">{formatDisplayTime(currentTime)}</div>
            <div class="control-hint">跟随念稿者同步</div>
          </div>
        {/if}

        <!-- 麦克风 -->
        <div class="panel-section">
          <div class="section-title">麦克风</div>
          <button class="btn btn-secondary" on:click={toggleMute}>
            {#if myMember?.muted}
              🔇 取消静音
            {:else}
              🎤 静音
            {/if}
          </button>
        </div>

        <!-- 成员列表 -->
        <div class="panel-section members-section">
          <div class="section-title">
            在线成员（{members.length}）
          </div>
          <div class="members-list">
            {#each members as m (m.userId)}
              <div class="member-item" class:presenter={m.isPresenter} class:me={m.userId === userId}>
                <span class="member-name">
                  {#if m.isPresenter}<span class="presenter-mark">🎙</span>{/if}
                  {memberLabel(m)}
                </span>
                <span class="member-state">
                  {#if m.muted}<span title="已静音">🔇</span>{/if}
                  {#if m.isSpeaking && !m.muted}<span class="speaking-dot" title="说话中"></span>{/if}
                </span>
              </div>
            {/each}
          </div>
        </div>
      </div>
    </div>
  {/if}

  <!-- 时长实测报告 -->
  {#if showDurationReport}
    <div class="duration-report">
      <div class="report-header">
        <span class="report-title">📊 时长实测报告</span>
        <span class="report-meta">
          录制时长 {recordingDuration.toFixed(1)}s · {durationReport.length} 条字幕被念到
        </span>
        <button class="btn btn-link" on:click={() => showDurationReport = false}>收起</button>
      </div>
      {#if durationReport.length === 0}
        <div class="report-empty">未记录到有效念稿数据</div>
      {:else}
        <table class="report-table">
          <thead>
            <tr>
              <th class="col-idx">#</th>
              <th class="col-text">文本预览</th>
              <th class="col-time">预估时长</th>
              <th class="col-time">实际时长</th>
              <th class="col-diff">偏差</th>
              <th class="col-status">状态</th>
            </tr>
          </thead>
          <tbody>
            {#each durationReport as row, i (row.event.id)}
              <tr class:over={row.overTime}>
                <td class="col-idx">{i + 1}</td>
                <td class="col-text">{row.cleanText.slice(0, 40) || '(空)'}</td>
                <td class="col-time">{row.estimated.toFixed(1)}s</td>
                <td class="col-time">{row.actual.toFixed(1)}s</td>
                <td class="col-diff">
                  {(row.actual - row.estimated).toFixed(1)}s
                </td>
                <td class="col-status">
                  {#if row.overTime}
                    <span class="warn">⚠ 超时</span>
                  {:else if row.estimated > 0 && row.actual < row.estimated * 0.5}
                    <span class="ok">⏩ 偏快</span>
                  {:else}
                    <span class="ok">✓ 正常</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
  {/if}
</div>

<style>
  .rehearsal-mode {
    display: flex;
    flex-direction: column;
    background: #f5f7fa;
    border-radius: 8px;
    overflow: hidden;
  }

  /* 控制条 */
  .control-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 14px;
    background: #ffffff;
    border-bottom: 1px solid #e1e4e8;
  }
  .control-left, .control-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .status-dot {
    font-size: 12px;
    color: #57606a;
    padding: 2px 8px;
    border-radius: 3px;
    background: #f6f8fa;
  }
  .status-dot.active {
    background: #dafbe1;
    color: #1a7f37;
  }
  .status-dot.sync {
    background: #ddf4ff;
    color: #0969da;
  }

  .btn {
    padding: 6px 14px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    color: white;
    transition: background 0.15s;
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary { background: #0969da; }
  .btn-primary:hover:not(:disabled) { background: #0860c7; }
  .btn-danger { background: #cf222e; }
  .btn-danger:hover { background: #b91c28; }
  .btn-secondary {
    background: #ffffff;
    color: #0969da;
    border: 1px solid #d0d7de;
  }
  .btn-secondary:hover:not(:disabled) { background: #ddf4ff; }
  .btn-secondary.small { padding: 3px 10px; font-size: 12px; }
  .btn-record { background: #1a7f37; }
  .btn-record:hover { background: #16863d; }
  .btn-recording {
    background: #cf222e;
    animation: pulse 1.5s infinite;
  }
  .btn-link {
    background: none;
    border: none;
    color: #0969da;
    cursor: pointer;
    font-size: 12px;
    padding: 2px 6px;
  }
  .btn-link:hover { text-decoration: underline; }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.7; }
  }

  .error-banner {
    background: #ffebe9;
    color: #cf222e;
    padding: 8px 14px;
    border-bottom: 1px solid #ffcecb;
    font-size: 13px;
  }
  .recording-status {
    background: #fff8c5;
    color: #57606a;
    padding: 6px 14px;
    border-bottom: 1px solid #e1e4e8;
    font-size: 12px;
  }

  /* 空闲面板 */
  .idle-panel {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 48px 24px;
    text-align: center;
    color: #57606a;
  }
  .idle-icon { font-size: 48px; margin-bottom: 12px; }
  .idle-title { font-size: 20px; font-weight: 600; color: #1a1a2e; margin-bottom: 8px; }
  .idle-desc { font-size: 13px; line-height: 1.8; color: #57606a; max-width: 480px; }

  /* 演练布局 */
  .rehearsal-layout {
    display: grid;
    grid-template-columns: 1fr 320px;
    gap: 12px;
    padding: 12px;
    height: calc(100vh - 200px);
    min-height: 400px;
  }
  .teleprompter-area {
    min-height: 0;
    overflow: hidden;
  }
  .side-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow-y: auto;
  }
  .panel-section {
    background: #ffffff;
    border: 1px solid #e1e4e8;
    border-radius: 8px;
    padding: 10px 12px;
  }
  .section-title {
    font-size: 11px;
    font-weight: 600;
    color: #57606a;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 8px;
  }
  .role-badge {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 12px;
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 6px;
  }
  .role-badge.presenter { background: #ddf4ff; color: #0969da; }
  .role-badge.audience { background: #f6f8fa; color: #57606a; }
  .control-hint { font-size: 12px; color: #8c959f; margin-bottom: 6px; }

  .play-controls {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .current-time {
    font-family: 'SF Mono', Monaco, monospace;
    font-size: 18px;
    color: #0969da;
    margin-top: 8px;
    font-weight: 600;
  }

  /* 成员列表 */
  .members-section { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .members-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    overflow-y: auto;
  }
  .member-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 8px;
    border-radius: 4px;
    background: #f6f8fa;
    font-size: 13px;
  }
  .member-item.presenter { background: #ddf4ff; }
  .member-item.me { border-left: 3px solid #0969da; }
  .member-name { color: #1a1a2e; }
  .presenter-mark { margin-right: 4px; }
  .member-state { display: flex; align-items: center; gap: 4px; }
  .speaking-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #1a7f37;
    display: inline-block;
    animation: speaking-pulse 1s infinite;
  }
  @keyframes speaking-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(1.3); }
  }

  /* 时长报告 */
  .duration-report {
    background: #ffffff;
    border-top: 2px solid #0969da;
    padding: 14px;
  }
  .report-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 10px;
  }
  .report-title { font-size: 14px; font-weight: 600; color: #1a1a2e; }
  .report-meta { font-size: 12px; color: #57606a; flex: 1; }
  .report-empty { text-align: center; color: #8c959f; padding: 20px; }
  .report-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .report-table th {
    text-align: left;
    padding: 6px 8px;
    background: #f6f8fa;
    color: #57606a;
    font-weight: 600;
    border-bottom: 1px solid #d0d7de;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .report-table td {
    padding: 6px 8px;
    border-bottom: 1px solid #eef0f2;
    color: #1a1a2e;
  }
  .report-table tr.over { background: #fff8c5; }
  .col-idx { width: 32px; color: #8c959f; }
  .col-text { min-width: 200px; }
  .col-time, .col-diff {
    width: 80px;
    font-family: 'SF Mono', Monaco, monospace;
    text-align: right;
  }
  .col-status { width: 80px; text-align: center; }
  .warn { color: #cf222e; font-weight: 600; }
  .ok { color: #1a7f37; font-weight: 600; }
</style>

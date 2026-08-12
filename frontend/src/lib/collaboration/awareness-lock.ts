/**
 * Awareness 协同操作
 * 段落锁、播放状态同步、在线用户感知
 * 复用 ScriptSync 的 awareness 思路，扩展为段落锁+播放控制权
 */
import type { WebsocketProvider } from 'y-websocket';
import type { AwarenessState } from '../../types/project';

/**
 * 锁定条目（进入编辑时调用，其他人看到光标但不抢编辑）
 */
export function lockEntry(
  provider: WebsocketProvider,
  entryId: string,
): void {
  provider.awareness.setLocalStateField('cursor', {
    entryId,
    typing: true,
  });
}

/**
 * 解锁条目（离开编辑时调用）
 */
export function unlockEntry(provider: WebsocketProvider): void {
  provider.awareness.setLocalStateField('cursor', {
    entryId: null,
    typing: false,
  });
}

/**
 * 检查某条目是否被他人锁定
 * @returns 锁定者的 userId，未锁定返回 null
 */
export function getLockHolder(
  provider: WebsocketProvider,
  entryId: string,
  myUserId: string,
): string | null {
  const states = provider.awareness.getStates();
  for (const [clientId, state] of states.entries()) {
    const cursor = state.cursor as AwarenessState['cursor'] | undefined;
    const user = state.user as { userId: string } | undefined;
    if (cursor?.entryId === entryId && user?.userId !== myUserId && cursor.typing) {
      return user?.userId ?? null;
    }
  }
  return null;
}

/**
 * 广播播放状态（编辑态：各自独立；演练态：一人控制众人跟随）
 */
export function broadcastPlayback(
  provider: WebsocketProvider,
  currentTime: number,
  isPlaying: boolean,
  isController: boolean,
): void {
  provider.awareness.setLocalStateField('playback', {
    currentTime,
    isPlaying,
    controllerId: isController ? provider.awareness.clientID : null,
  });
}

/**
 * 订阅播放状态变化（演练态：跟随控制者）
 * @param callback 收到控制者播放状态时的回调
 */
export function subscribePlayback(
  provider: WebsocketProvider,
  controllerClientId: number,
  callback: (currentTime: number, isPlaying: boolean) => void,
): () => void {
  const handler = () => {
    const states = provider.awareness.getStates();
    const controllerState = states.get(controllerClientId);
    const playback = controllerState?.playback as
      | { currentTime: number; isPlaying: boolean; controllerId: number | null }
      | undefined;
    if (playback && playback.controllerId === controllerClientId) {
      callback(playback.currentTime, playback.isPlaying);
    }
  };
  provider.awareness.on('change', handler);
  return () => provider.awareness.off('change', handler);
}

/**
 * 获取所有在线用户
 */
export function getOnlineUsers(
  provider: WebsocketProvider,
): { userId: string; username: string; color: string; clientId: number }[] {
  const states = provider.awareness.getStates();
  const users: { userId: string; username: string; color: string; clientId: number }[] = [];
  for (const [clientId, state] of states.entries()) {
    const user = state.user as { userId: string; username: string; color: string } | undefined;
    if (user) {
      users.push({ ...user, clientId });
    }
  }
  return users;
}

/**
 * 获取所有「他人」正在编辑的光标位置
 * @param myUserId 当前用户 userId，用于排除自己
 * @returns Map<entryId, { userId, username, color }>，同一行多人编辑时取最后写入者
 */
export function getOtherCursors(
  provider: WebsocketProvider,
  myUserId: string,
): Map<string, { userId: string; username: string; color: string }> {
  const result = new Map<string, { userId: string; username: string; color: string }>();
  const states = provider.awareness.getStates();
  for (const [, state] of states.entries()) {
    const cursor = state.cursor as AwarenessState['cursor'] | undefined;
    const user = state.user as { userId: string; username: string; color: string } | undefined;
    if (cursor?.entryId && cursor.typing && user && user.userId !== myUserId) {
      // 多人编辑同一行时，后者覆盖前者（awareness 无序，UI 层足够提示「有人在编辑」）
      result.set(cursor.entryId, { userId: user.userId, username: user.username, color: user.color });
    }
  }
  return result;
}

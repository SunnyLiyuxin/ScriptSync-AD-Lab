/**
 * 快捷键管理器（Aegisub 级）
 * Svelte 原生实现，无第三方依赖。
 *
 * 设计要点：
 * - 注册/注销快捷键，统一规范化键名（修饰键顺序 Ctrl+Alt+Shift+Meta + 主键）
 * - 冲突检测：同一键位重复注册时拒绝并告警
 * - 全局启用/禁用（编辑文本时禁用），并自动忽略输入控件内的按键
 * - getShortcuts() 供快捷键列表 UI 展示
 * - useShortcuts action 激活全局监听（绑定到 window）
 */
import type { Action } from 'svelte/action';

/** 快捷键信息（列表展示用） */
export interface ShortcutInfo {
  key: string;
  description: string;
}

interface ShortcutEntry {
  key: string;
  handler: () => void;
  description: string;
}

export interface ShortcutManager {
  /** 注册快捷键；键位冲突时返回 false 并告警 */
  register: (key: string, handler: () => void, description: string) => boolean;
  /** 注销快捷键 */
  unregister: (key: string) => void;
  /** 启用/禁用全局快捷键（编辑文本时禁用） */
  setEnabled: (enabled: boolean) => void;
  /** 当前是否启用 */
  isEnabled: () => boolean;
  /** 是否存在键位冲突 */
  hasConflict: (key: string) => boolean;
  /** 获取已注册快捷键列表 */
  getShortcuts: () => ShortcutInfo[];
  /** keydown 处理器（可直接用于 <svelte:window on:keydown>） */
  handleKeyDown: (e: KeyboardEvent) => void;
  /** 销毁：清空注册表 */
  destroy: () => void;
}

const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;

/** 主键别名表（小写 → 规范名） */
const SPECIAL_KEY_MAP: Record<string, string> = {
  ' ': 'Space',
  space: 'Space',
  spacebar: 'Space',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  insert: 'Insert',
  delete: 'Delete',
  del: 'Delete',
  enter: 'Enter',
  return: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  tab: 'Tab',
  backspace: 'Backspace',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
};

/** 规范化主键名 */
function normalizeMainKey(k: string): string {
  const lower = k.toLowerCase();
  if (SPECIAL_KEY_MAP[lower]) return SPECIAL_KEY_MAP[lower];
  if (k.length === 1) return k.toUpperCase();
  return k;
}

/** 规范化快捷键字符串，如 "ctrl+shift+ArrowLeft" → "Ctrl+Shift+ArrowLeft" */
function normalizeKey(key: string): string {
  const parts = key.split('+').map(p => p.trim()).filter(Boolean);
  const mods = new Set<string>();
  let main = '';
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') mods.add('Ctrl');
    else if (lower === 'alt' || lower === 'option' || lower === 'opt') mods.add('Alt');
    else if (lower === 'shift') mods.add('Shift');
    else if (lower === 'meta' || lower === 'cmd' || lower === 'command' || lower === 'win') mods.add('Meta');
    else main = normalizeMainKey(p);
  }
  const modStr = MOD_ORDER.filter(m => mods.has(m)).join('+');
  return modStr ? `${modStr}+${main}` : main;
}

/** 从 KeyboardEvent 构造规范化键名 */
function eventToKey(e: KeyboardEvent): string {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Meta');
  const main = normalizeMainKey(e.key);
  return mods.length ? `${mods.join('+')}+${main}` : main;
}

/** 判断事件目标是否为文本输入控件（编辑文本时禁用全局快捷键） */
function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * 创建快捷键管理器
 */
export function createShortcutManager(): ShortcutManager {
  const shortcuts = new Map<string, ShortcutEntry>();
  let enabled = true;

  const handleKeyDown = (e: KeyboardEvent): void => {
    if (!enabled) return;
    if (isTextInput(e.target)) return; // 编辑文本时禁用全局快捷键
    const key = eventToKey(e);
    const entry = shortcuts.get(key);
    if (entry) {
      e.preventDefault();
      entry.handler();
    }
  };

  const register = (key: string, handler: () => void, description: string): boolean => {
    const normalized = normalizeKey(key);
    if (!normalized) return false;
    if (shortcuts.has(normalized)) {
      const existing = shortcuts.get(normalized);
      console.warn(
        `[shortcut-manager] 快捷键冲突: "${normalized}" 已注册（${existing?.description ?? ''}），无法绑定「${description}」`,
      );
      return false;
    }
    shortcuts.set(normalized, { key: normalized, handler, description });
    return true;
  };

  const unregister = (key: string): void => {
    shortcuts.delete(normalizeKey(key));
  };

  const hasConflict = (key: string): boolean => shortcuts.has(normalizeKey(key));

  const getShortcuts = (): ShortcutInfo[] =>
    Array.from(shortcuts.values()).map(s => ({ key: s.key, description: s.description }));

  const setEnabled = (value: boolean): void => { enabled = value; };
  const isEnabled = (): boolean => enabled;

  const destroy = (): void => {
    shortcuts.clear();
    enabled = false;
  };

  return {
    register,
    unregister,
    setEnabled,
    isEnabled,
    hasConflict,
    getShortcuts,
    handleKeyDown,
    destroy,
  };
}

/** 默认快捷键定义（键名 + 说明），供列表展示与批量注册 */
export const DEFAULT_SHORTCUTS: ReadonlyArray<{ key: string; description: string }> = [
  { key: 'Space', description: '播放/暂停视频' },
  { key: 'Insert', description: '在当前位置插入新行' },
  { key: 'Delete', description: '删除当前行（软删除）' },
  { key: 'S', description: '分割当前行（在播放头位置分成两半）' },
  { key: 'ArrowUp', description: '上一行' },
  { key: 'ArrowDown', description: '下一行' },
  { key: 'Ctrl+ArrowLeft', description: '当前行开始时间后退0.1秒' },
  { key: 'Ctrl+ArrowRight', description: '当前行开始时间前进0.1秒' },
  { key: 'Ctrl+Shift+ArrowLeft', description: '当前行结束时间后退0.1秒' },
  { key: 'Ctrl+Shift+ArrowRight', description: '当前行结束时间前进0.1秒' },
  { key: 'Ctrl+Enter', description: '提交当前行到审阅状态（draft → peer_review）' },
  { key: 'Ctrl+J', description: '跳转到下一个空白口述行' },
  { key: 'Ctrl+K', description: '跳转到上一个空白口述行' },
  { key: 'Escape', description: '取消编辑/取消选中' },
];

/** 默认快捷键回调集合 */
export interface ShortcutHandlers {
  togglePlay: () => void;
  insertRow: () => void;
  deleteRow: () => void;
  splitRow: () => void;
  moveUp: () => void;
  moveDown: () => void;
  nudgeStartBack: () => void;
  nudgeStartForward: () => void;
  nudgeEndBack: () => void;
  nudgeEndForward: () => void;
  submitForReview: () => void;
  jumpNextBlank: () => void;
  jumpPrevBlank: () => void;
  cancel: () => void;
}

/**
 * 将默认快捷键集合批量注册到管理器。
 * @returns 注册成功的数量（冲突的会被跳过）
 */
export function createDefaultShortcuts(
  manager: ShortcutManager,
  handlers: ShortcutHandlers,
): number {
  let count = 0;
  for (const def of DEFAULT_SHORTCUTS) {
    const h = handlerFor(def.key, handlers);
    if (h && manager.register(def.key, h, def.description)) count++;
  }
  return count;
}

function handlerFor(key: string, h: ShortcutHandlers): (() => void) | null {
  switch (key) {
    case 'Space': return h.togglePlay;
    case 'Insert': return h.insertRow;
    case 'Delete': return h.deleteRow;
    case 'S': return h.splitRow;
    case 'ArrowUp': return h.moveUp;
    case 'ArrowDown': return h.moveDown;
    case 'Ctrl+ArrowLeft': return h.nudgeStartBack;
    case 'Ctrl+ArrowRight': return h.nudgeStartForward;
    case 'Ctrl+Shift+ArrowLeft': return h.nudgeEndBack;
    case 'Ctrl+Shift+ArrowRight': return h.nudgeEndForward;
    case 'Ctrl+Enter': return h.submitForReview;
    case 'Ctrl+J': return h.jumpNextBlank;
    case 'Ctrl+K': return h.jumpPrevBlank;
    case 'Escape': return h.cancel;
    default: return null;
  }
}

/**
 * Svelte action：激活全局快捷键监听（始终绑定到 window，与挂载节点无关）。
 *
 * 用法（二选一，勿重复挂载以免重复触发）：
 *   1) 挂载到任意容器元素：
 *      <div use:useShortcuts={manager}>…</div>
 *   2) 直接监听 svelte:window：
 *      <svelte:window on:keydown={manager.handleKeyDown} />
 */
export const useShortcuts: Action<HTMLElement, ShortcutManager | undefined> = (
  _node,
  manager,
) => {
  if (!manager) return;
  window.addEventListener('keydown', manager.handleKeyDown);
  return {
    destroy() {
      window.removeEventListener('keydown', manager.handleKeyDown);
    },
  };
};

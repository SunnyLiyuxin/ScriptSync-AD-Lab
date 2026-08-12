/** 项目与协作相关类型定义 */

/** 项目成员角色
 * - owner：发起人/统筹，项目创建者，独有 owner 转让/移除成员/版本管理等权限
 * - manager：管理员，可分配工作、添加成员（不能改 owner/移除 owner）
 * - reviewer：审阅人，可批注可编辑他人行
 * - narrator：口述员，默认角色，仅可编辑自己负责的行
 */
export type MemberRole = 'owner' | 'manager' | 'narrator' | 'reviewer';

/** 项目成员 */
export interface ProjectMember {
  userId: string;
  username: string;
  role: MemberRole;
  joinedAt: number;
}

/** 权限位（与后端 require_project_role 对齐） */
export type Permission =
  | 'manage_members'      // 添加/移除/改成员角色
  | 'assign_work'         // 分配工作（批量指派、波形拖选）
  | 'edit_others_rows'    // 编辑他人负责的行
  | 'edit_own_rows'       // 编辑自己负责的行
  | 'comment'             // 批注
  | 'export'              // 导出
  | 'version_manage'      // 版本管理（创建快照/回滚）
  | 'view_all_rows';      // 查看所有行

/** 角色权限矩阵（与定位报告第九章一致） */
export const ROLE_PERMISSIONS: Record<MemberRole, Set<Permission>> = {
  owner: new Set<Permission>([
    'manage_members', 'assign_work', 'edit_others_rows', 'edit_own_rows',
    'comment', 'export', 'version_manage', 'view_all_rows',
  ]),
  manager: new Set<Permission>([
    'assign_work', 'edit_others_rows', 'edit_own_rows',
    'comment', 'export', 'view_all_rows',
  ]),
  reviewer: new Set<Permission>([
    'edit_others_rows', 'edit_own_rows', 'comment', 'export', 'view_all_rows',
  ]),
  narrator: new Set<Permission>([
    'edit_own_rows', 'comment', 'export', 'view_all_rows',
  ]),
};

/** 权限判定工具 */
export function hasPermission(role: MemberRole | null | undefined, perm: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.has(perm) ?? false;
}

/** 角色中文标签 */
export const ROLE_LABELS: Record<MemberRole, string> = {
  owner: '统筹',
  manager: '管理员',
  reviewer: '审阅',
  narrator: '口述员',
};

/** 项目元数据（存 RDS，非 Yjs） */
export interface Project {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  members: ProjectMember[];
  createdAt: number;
  updatedAt: number;

  // 片源信息
  videoSource?: VideoSource;

  // 进度统计
  stats?: ProjectStats;
}

/** 片源信息 */
export interface VideoSource {
  ossKey: string;         // OSS 存储路径
  filename: string;
  duration: number;       // 秒
  uploadedBy: string;
  uploadedAt: number;
}

/** 项目进度统计 */
export interface ProjectStats {
  total: number;          // 总字幕条数
  empty: number;
  draft: number;
  peerReview: number;
  approved: number;
  locked: number;
}

/** 段落分配（责任划分） */
export interface SegmentAssignment {
  id: string;
  start: number;          // 段落起始时间（秒）
  end: number;            // 段落结束时间（秒）
  assigneeId: string | null;
  assigneeName: string | null;
  label?: string;         // 段落标注（如"开场""第一幕"）
}

/** 在线用户 awareness 状态 */
export interface AwarenessState {
  userId: string;
  username: string;
  color: string;          // 协作光标颜色
  cursor: {
    entryId: string | null;
    typing: boolean;
  };
  playback?: {
    currentTime: number;
    isPlaying: boolean;
    controllerId: string | null;  // 演练态同步播放的控制者
  };
}

/** Yjs 文档结构（房间内共享文档的顶层结构） */
import type { AssStyle, AssEvent, ReviewComment } from './ass';

export interface YjsDocStructure {
  meta: Project;                              // getMap('meta')
  scriptInfo: Record<string, string>;         // getMap('scriptInfo')
  styles: AssStyle[];                         // getArray('styles')
  events: AssEvent[];                         // getArray('events') 核心
  comments: Record<string, ReviewComment[]>;  // getMap('comments') 按eventId索引
  assignments: SegmentAssignment[];           // getArray('assignments')
}

/** 版本快照 */
export interface VersionSnapshot {
  id: string;
  projectId: string;
  createdAt: number;
  createdBy: string;
  label: string;
  size: number;            // 字节数
  ossKey: string;
}

/** 修改历史记录（修改追踪，V1.5） */
export interface EditHistoryEntry {
  userId: string;
  username: string;
  timestamp: number;
  field: 'text' | 'start' | 'end' | 'status';  // 修改的字段
  oldValue: string;
  newValue: string;
}

/** 同步播放状态（V2，独立 WebSocket 通道，不走 Yjs） */
export interface SyncPlayState {
  type: 'play' | 'pause' | 'seek';
  currentTime: number;
  controllerId: string;     // 主持人ID
  controllerName: string;
  timestamp: number;
}

/** 语音房间成员（V2） */
export interface VoiceRoomMember {
  userId: string;
  username: string;
  muted: boolean;
  isSpeaking: boolean;
  isPresenter: boolean;     // 是否为当前念稿者
  joinedAt: number;
}

/** 演练状态（V2） */
export interface RehearsalState {
  active: boolean;
  presenterId: string | null;   // 当前念稿者
  presenterName: string | null;
  startedAt: number | null;
  recording: boolean;           // 是否在录制
  currentCueId: string | null;  // 当前念到的条目
}

/** AI 衔接检查结果（V2） */
export interface ContinuityIssue {
  event_id_a: string;
  event_id_b: string;
  issue_type: 'reference_ambiguous' | 'subject_missing' | 'tone_inconsistent' | 'other';
  description: string;
  suggestion: string;
}

/** AI 用词一致性检查结果（V1.5） */
export interface ConsistencyIssue {
  word_a: string;
  word_b: string;
  occurrences: { event_id: string; text: string }[];
  suggestion: string;
}

/** AI 时长预估结果（V1.5） */
export interface DurationEstimate {
  char_count: number;
  estimated_duration: number;   // 秒
  speed: number;                // 字/秒
}

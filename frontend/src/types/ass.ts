/**
 * ASS 字幕相关核心类型定义
 * 贯穿前后端的数据契约，对应后端 Python 的等价结构
 */

/** 字幕条目状态机：口述稿全流程流转状态 */
export type EventStatus =
  | 'draft'          // 初稿
  | 'needs_revision' // 需修改
  | 'in_review'      // 审阅中
  | 'approved'       // 已通过
  | 'locked'         // 已锁定
  | 'deleted';       // 已删除（可由 owner 恢复）

/** ASS 内联标签解析结果 */
export interface InlineTagResult {
  rawText: string;       // 原始文本（含标签）
  cleanText: string;     // 清洗后正文（供编辑展示）
  tags: string[];        // 标签列表（如 ['{\\pos(960,900)}', '{\\fad(200,300)}']）
}

/** ASS 样式（V4+ Styles 段） */
export interface AssStyle {
  Name: string;
  Fontname: string;
  Fontsize: number;
  PrimaryColour: string;
  SecondaryColour: string;
  OutlineColour: string;
  BackColour: string;
  Bold: boolean;
  Italic: boolean;
  Underline: boolean;
  StrikeOut: boolean;
  ScaleX: number;
  ScaleY: number;
  Spacing: number;
  Angle: number;
  BorderStyle: number;
  Outline: number;
  Shadow: number;
  Alignment: number;
  MarginL: number;
  MarginR: number;
  MarginV: number;
  Encoding: number;
}

/** ASS 字幕事件（核心数据结构，对应 Yjs events 数组中的每一条） */
export interface AssEvent {
  id: string;            // 唯一ID（nanoid 生成）
  layer: number;         // 0=对白, 1=口述
  start: number;         // 开始时间（秒，浮点）
  end: number;           // 结束时间（秒，浮点）
  style: string;         // 样式名
  name: string;          // 说话人名称（ASS Name字段）
  text: string;          // 字幕正文（含内联标签）

  // —— 协作元数据字段（带下划线前缀，与 ASS 原生字段区分）——
  _status: EventStatus;
  _lockedBy: string | null;       // 当前持有锁的用户ID
  _assignedTo: string | null;     // 被指派的口述员ID
  _owner: string | null;          // 导入者ID（内容归属，用于「只看自己」过滤）
  _needsRevisionBy: string | null;      // 标记 needs_revision 的普通成员 userId（仅该状态显示头像）
  _needsRevisionByName: string | null;  // 对应昵称（头像首字）

  // —— V1.5 预留字段（梯度升级时不破坏现有数据结构）——
  _reviewComments?: ReviewComment[];  // 审阅批注
  _audioRecording?: string;           // 演练录音URL（V2）
  _rehearsalState?: string;           // 演练状态（V2）
  _aiSuggestion?: AiSuggestion;       // AI客观中性改写建议（V1.5）
  _wordCount?: number;                // 字数（用于时长预估，V1.5）
}

/** 审阅批注 */
export interface ReviewComment {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: number;      // 时间戳
  resolved: boolean;
  position?: number;      // 在文本中的字符位置（用于锚定批注）
  replies?: ReviewComment[]; // 嵌套回复（V1.5 批注面板）
}

/** AI客观中性改写建议 */
export interface AiSuggestion {
  originalText: string;
  rewrittenText: string;      // 改写推荐（字数偏差≤10%）
  subjectiveWords: SubjectiveWord[];  // 标记的主观词
  model: string;              // 使用的模型名
  createdAt: number;
  status: 'pending' | 'accepted' | 'rejected' | 'edited';
}

/** 主观词标记 */
export interface SubjectiveWord {
  word: string;
  position: number;       // 在原文中的起始位置
  reason: string;         // 为什么判定为主观（如"评价性形容词"）
  suggestion: string;     // 客观化替代建议
}

/** ASS 完整文档结构 */
export interface AssDocument {
  scriptInfo: Record<string, string>;
  styles: AssStyle[];
  events: AssEvent[];
}

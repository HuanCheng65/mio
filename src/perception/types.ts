export interface NormalizedMessage {
  id: string;                    // 消息 ID
  sender: string;                // 显示名
  senderId: string;              // QQ号 / user_id
  senderRole?: '群主' | '管理员'; // 固定身份标识，渲染在名字前面
  senderTitle?: string;          // 群主手动授予的自定义称号，渲染在名字后面
  isBot: boolean;                // 是否是澪自己发的
  timestamp: number;

  segments: MessageSegment[];

  replyTo?: ReplyInfo;           // 引用回复
  mentions: MentionInfo[];       // 所有 @

  reactions?: ReactionInfo[];    // 消息的 reaction
  recalled?: boolean;            // 是否已被撤回
  recalledAt?: number;           // 撤回时间
  
  rawContent?: string;           // 原始 Koishi session.content（保留作为备份）
}

export type MessageSegment =
  | TextSegment
  | ImageSegment
  | FaceSegment
  | ShareSegment
  | ForwardSegment
  | RecallNotice
  | PokeSegment
  | UnsupportedSegment;

export interface TextSegment {
  type: 'text';
  content: string;
}

export interface ImageSegment {
  type: 'image';
  url: string;
  description: string | null;  // LLM 理解结果，null = 尚未处理
  isSticker: boolean;
  width?: number;
  height?: number;
}

export interface FaceSegment {
  type: 'face';
  faceId: number;
  name: string;
}

export interface ShareSegment {
  type: 'share';
  subtype: 'link' | 'music' | 'video' | 'miniapp' | 'unknown';
  title: string;
  description?: string;
  platform?: string;
  url?: string;
}

export interface ForwardSegment {
  type: 'forward';
  summary: string;
}

export interface RecallNotice {
  type: 'recall';
  recalledBy: string;
  originalPreview: string | null;
}

export interface PokeSegment {
  type: 'poke';
  target: string;
  action: string;
}

export interface UnsupportedSegment {
  type: 'unsupported';
  hint: string;
}

export interface ReplyInfo {
  messageId: string;
  sender: string;
  preview: string;
}

export interface MentionInfo {
  userId: string;
  displayName: string;
  isBot: boolean;
}

export interface ReactionInfo {
  emoji: string;
  count: number;
  includesBot: boolean;
  reactors: string[];
}

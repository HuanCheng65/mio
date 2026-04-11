export interface LLMResponse {
  thought: string;
  urge: number;       // 0-10, how much the bot wants to speak
  silent: boolean;    // derived in code: urge < SILENCE_THRESHOLD
  search: SearchRequest | null;
  actions: Action[];
}

/** urge values below this threshold are treated as silent */
export const SILENCE_THRESHOLD = 7;

export interface SearchRequest {
  query?: string;
  target_msg_id?: string;
  target_image_index?: number;
  hint: 'anime' | 'galgame' | 'music' | 'general' | 'image';
  intent: string;
}

export type Action = MessageAction | ReplyAction | ReactAction | StickerAction | RecallAction;

export interface MessageAction {
  type: 'message';
  content: string;
}

export interface ReplyAction {
  type: 'reply';
  target_msg_id: string;  // short ID, e.g. "m5"
  text: string;
}

export interface ReactAction {
  type: 'react';
  target_msg_id: string;  // short ID, e.g. "m5"
  emoji_name: string;     // QQ face name, e.g. "赞", "笑哭"
}

export interface StickerAction {
  type: 'sticker';
  intent: string;   // free-text: "笑死 太惨了 幸灾乐祸"
}

export interface RecallAction {
  type: 'recall';
  target_msg_id: string;  // short ID, e.g. "m5"
}

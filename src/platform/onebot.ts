import type { Session } from "koishi";

/**
 * OneBot 专用能力。Satori 标准接口覆盖不到，只能走 bot.internal：
 * - 表情回应：@wittf/koishi-plugin-adapter-onebot 没有实现标准的 createReaction
 * - 群身份/头衔：标准 GuildMember 没有头衔字段
 * 其他平台（如官方 QQ 群聊）没有这些能力，调用方需先用 isOneBot 判断。
 */
interface OneBotInternal {
  setMsgEmojiLike(messageId: string, emojiId: string): Promise<void>;
  getGroupMemberInfo(groupId: string, userId: string, noCache: boolean): Promise<{ role?: string; title?: string }>;
}

export function isOneBot(session: Session): boolean {
  return session.platform === "onebot";
}

function internal(session: Session): OneBotInternal {
  if (!isOneBot(session)) throw new Error(`not a OneBot session: ${session.platform}`);
  return session.bot.internal as OneBotInternal;
}

export async function setMsgEmojiLike(session: Session, messageId: string, emojiId: string): Promise<void> {
  await internal(session).setMsgEmojiLike(messageId, emojiId);
}

export async function getGroupMemberInfo(session: Session, groupId: string, userId: string) {
  return internal(session).getGroupMemberInfo(groupId, userId, false);
}

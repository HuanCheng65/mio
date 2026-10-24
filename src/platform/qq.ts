import type { Session } from "koishi";

/**
 * 官方 QQ 群聊的被动回复规则：带 msg_id 的回复 5 分钟内有效，每条消息最多回复 5 次。
 * 超出窗口时 adapter-qq 会去掉 msg_id 改发主动消息（占用每日主动消息额度），超出次数则被平台拒绝。
 * mio 不主动占用额度：发送前检查，不满足就不发。
 */
const PASSIVE_WINDOW_MS = 5 * 60_000;
const PASSIVE_REPLY_LIMIT = 5;
// 检查和真正发出之间还有网络往返，留出余量，避免卡在窗口边缘被适配器转成主动消息
const WINDOW_SAFETY_MARGIN_MS = 30_000;

const repliesBySession = new WeakMap<Session, number>();

export function isQQOfficial(session: Session): boolean {
  return session.platform === "qq";
}

/** 返回不能被动回复的原因；可以发送时返回 null。非官方 QQ 平台没有这些限制。 */
export function passiveReplyBlocker(session: Session): string | null {
  if (!isQQOfficial(session)) return null;
  if (!session.messageId) return "没有可挂靠的消息 id";
  const age = Date.now() - session.timestamp;
  if (age > PASSIVE_WINDOW_MS - WINDOW_SAFETY_MARGIN_MS) {
    return `挂靠的消息已过去 ${Math.round(age / 1000)} 秒，超出被动回复窗口`;
  }
  if ((repliesBySession.get(session) ?? 0) >= PASSIVE_REPLY_LIMIT) {
    return `挂靠的消息已用完 ${PASSIVE_REPLY_LIMIT} 次被动回复`;
  }
  return null;
}

export function recordPassiveReply(session: Session): void {
  if (!isQQOfficial(session)) return;
  repliesBySession.set(session, (repliesBySession.get(session) ?? 0) + 1);
}

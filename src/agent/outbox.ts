import type { Session } from "koishi";

export interface OutboxLimits {
  /** 两次发送之间的最短间隔 */
  minIntervalMs: number;
  /** 每小时最多发几条 */
  maxPerHour: number;
  /** 没人接话时最多连着发几条 */
  maxConsecutive: number;
}

const HOUR = 3600_000;
const OWN_MESSAGES_KEPT = 200;

/**
 * 每个群的发送状态：最新一条群友消息的会话（官方 QQ 的被动回复要挂在它上面）、
 * 防刷屏计数、自己发出的消息 ID（用来认出"有人在回复澪"）。
 * 护栏只防失控，放得宽；什么时候开口由模型自己判断。
 */
export class Outbox {
  private latest = new Map<string, Session>();
  private sentAt = new Map<string, number[]>();
  private consecutive = new Map<string, number>();
  private own = new Map<string, string[]>();

  constructor(private limits: OutboxLimits) {}

  noteUserMessage(groupId: string, session: Session): void {
    this.latest.set(groupId, session);
    this.consecutive.set(groupId, 0);
  }

  latestSession(groupId: string): Session | undefined {
    return this.latest.get(groupId);
  }

  /** 被护栏拦下时返回给模型看的说明；可以发时返回 null */
  blocker(groupId: string, now = Date.now()): string | null {
    const recent = (this.sentAt.get(groupId) ?? []).filter((t) => now - t < HOUR);
    this.sentAt.set(groupId, recent);
    const last = recent.at(-1);
    if (last !== undefined && now - last < this.limits.minIntervalMs) {
      return `刚发过一条，${Math.ceil((this.limits.minIntervalMs - (now - last)) / 1000)} 秒内先别发`;
    }
    if (recent.length >= this.limits.maxPerHour) {
      return `这一小时已经说了 ${recent.length} 条，歇一会儿`;
    }
    const streak = this.consecutive.get(groupId) ?? 0;
    if (streak >= this.limits.maxConsecutive) {
      return `已经连着说了 ${streak} 条没人接，先停一下，等别人说话`;
    }
    return null;
  }

  recordSent(groupId: string, messageIds: string[], now = Date.now()): void {
    this.sentAt.set(groupId, [...(this.sentAt.get(groupId) ?? []), now]);
    this.consecutive.set(groupId, (this.consecutive.get(groupId) ?? 0) + 1);
    if (messageIds.length > 0) {
      this.own.set(groupId, [...(this.own.get(groupId) ?? []), ...messageIds].slice(-OWN_MESSAGES_KEPT));
    }
  }

  isOwnMessage(groupId: string, messageId: string): boolean {
    return this.own.get(groupId)?.includes(messageId) ?? false;
  }
}

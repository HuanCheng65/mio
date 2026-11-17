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
  private bannedUntil = new Map<string, number>();

  constructor(private limits: OutboxLimits) {}

  noteUserMessage(groupId: string, session: Session): void {
    this.latest.set(groupId, session);
    this.consecutive.set(groupId, 0);
  }

  latestSession(groupId: string): Session | undefined {
    return this.latest.get(groupId);
  }

  /** 澪在这个群被 QQ 禁言到什么时候（Infinity：直到解除）；null 表示解除 */
  setBanned(groupId: string, until: number | null): void {
    if (until === null) this.bannedUntil.delete(groupId);
    else this.bannedUntil.set(groupId, until);
  }

  /** 被护栏拦下时返回给模型看的说明；可以发时返回 null */
  blocker(groupId: string, now = Date.now()): string | null {
    const banned = this.bannedUntil.get(groupId);
    if (banned !== undefined) {
      if (banned === Infinity) return "你在这个群被禁言了，解除之前发不出去";
      if (now < banned) return `你在这个群被禁言了，还有 ${Math.ceil((banned - now) / 60_000)} 分钟才解除，现在发不出去`;
      this.bannedUntil.delete(groupId);
    }
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

  /** 某个时刻以来发了几条（只记得最近一小时） */
  sentSince(groupId: string, since: number): number {
    return (this.sentAt.get(groupId) ?? []).filter((t) => t >= since).length;
  }

  lastSentAt(groupId: string): number | undefined {
    return this.sentAt.get(groupId)?.at(-1);
  }

  isOwnMessage(groupId: string, messageId: string): boolean {
    return this.own.get(groupId)?.includes(messageId) ?? false;
  }
}

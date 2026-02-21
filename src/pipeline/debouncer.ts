import { NormalizedMessage } from '../perception/types';

export interface DebouncerConfig {
  waitMs: number;        // 停顿判定时间（默认 5000ms）
  maxWaitMs: number;     // 最长等待时间（默认 30000ms）
}

/**
 * Debounce 触发控制器
 */
export class Debouncer {
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private firstMessageTime: Map<string, number> = new Map();
  private config: DebouncerConfig;

  constructor(config: DebouncerConfig) {
    this.config = config;
  }

  /**
   * 处理新消息，决定是否触发回调
   */
  onMessage(
    groupId: string,
    msg: NormalizedMessage,
    mentionsBot: boolean,
    callback: () => void
  ): void {
    // 被 @ 或叫名字 → 立即触发
    if (mentionsBot) {
      this.cancelTimer(groupId);
      this.firstMessageTime.delete(groupId);
      callback();
      return;
    }

    // 记录这轮 debounce 的第一条消息时间
    if (!this.firstMessageTime.has(groupId)) {
      this.firstMessageTime.set(groupId, Date.now());
    }

    // 检查是否超过最长等待（对话太活跃，一直没停顿）
    const waitedMs = Date.now() - this.firstMessageTime.get(groupId)!;
    if (waitedMs >= this.config.maxWaitMs) {
      this.cancelTimer(groupId);
      this.firstMessageTime.delete(groupId);
      callback();
      return;
    }

    // 正常 debounce：重置计时器
    this.cancelTimer(groupId);
    this.timers.set(
      groupId,
      setTimeout(() => {
        this.firstMessageTime.delete(groupId);
        callback();
      }, this.config.waitMs)
    );
  }

  /**
   * 手动重新启动一个 debounce 周期
   * 用于：上一次处理完成后发现有漏掉的消息
   */
  restart(groupId: string, callback: () => void): void {
    this.cancelTimer(groupId);
    this.firstMessageTime.set(groupId, Date.now());
    this.timers.set(
      groupId,
      setTimeout(() => {
        this.firstMessageTime.delete(groupId);
        callback();
      }, this.config.waitMs)
    );
  }

  /**
   * 取消指定群的计时器
   */
  private cancelTimer(groupId: string): void {
    const timer = this.timers.get(groupId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(groupId);
    }
  }

  /**
   * 清理所有计时器（插件卸载时调用）
   */
  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.firstMessageTime.clear();
  }
}

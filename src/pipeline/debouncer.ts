import { NormalizedMessage } from '../perception/types';

export interface DebouncerConfig {
  idleMs: number;      // 消息间隔窗口期（默认 5000ms）
  minWaitMs: number;   // 基准最短等待（默认 8000ms）
  maxWaitMs: number;   // 基准最长等待（默认 45000ms）
}

interface TimingProfile {
  minWaitMs: number;
  maxWaitMs: number;
}

/**
 * Debounce 触发控制器
 *
 * 三种时序档位：
 * - engaged: 本轮有消息 @/回复了 bot → 快速响应
 * - cooldown: bot 最近 90s 内说过话 → 拉长等待
 * - normal: 默认
 *
 * 优先级：engaged > cooldown > normal
 */
export class Debouncer {
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private firstMessageTime: Map<string, number> = new Map();
  private lastSpokeAt: Map<string, number> = new Map();
  private engagedGroups: Set<string> = new Set();
  private config: DebouncerConfig;

  constructor(config: DebouncerConfig) {
    this.config = config;
  }

  /**
   * 记录 bot 在某个群发言了
   */
  markSpoke(groupId: string): void {
    this.lastSpokeAt.set(groupId, Date.now());
  }

  /**
   * 根据当前状态选择时序档位
   */
  private selectProfile(groupId: string): TimingProfile {
    // engaged 优先级最高
    if (this.engagedGroups.has(groupId)) {
      return {
        minWaitMs: this.config.idleMs,
        maxWaitMs: this.config.maxWaitMs / 3,
      };
    }

    // cooldown: bot 最近 90s 内说过话
    const lastSpoke = this.lastSpokeAt.get(groupId);
    if (lastSpoke && Date.now() - lastSpoke < 90_000) {
      return {
        minWaitMs: this.config.minWaitMs * 2.5,
        maxWaitMs: this.config.maxWaitMs * 1.5,
      };
    }

    // normal
    return {
      minWaitMs: this.config.minWaitMs,
      maxWaitMs: this.config.maxWaitMs,
    };
  }

  /**
   * 处理新消息，决定是否触发回调
   */
  onMessage(
    groupId: string,
    msg: NormalizedMessage,
    engaged: boolean,
    callback: () => void
  ): void {
    // 记录这轮 debounce 的第一条消息时间
    if (!this.firstMessageTime.has(groupId)) {
      this.firstMessageTime.set(groupId, Date.now());
    }

    // 标记本批次的 engaged 状态
    if (engaged) {
      this.engagedGroups.add(groupId);
    }

    const profile = this.selectProfile(groupId);
    const elapsed = Date.now() - this.firstMessageTime.get(groupId)!;

    // 超过最长等待 → 立即触发
    if (elapsed >= profile.maxWaitMs) {
      this.cancelTimer(groupId);
      this.resetBatch(groupId);
      callback();
      return;
    }

    // 正常 debounce：重置 idle 计时器
    this.cancelTimer(groupId);
    this.timers.set(
      groupId,
      setTimeout(() => {
        const currentElapsed = Date.now() - (this.firstMessageTime.get(groupId) ?? Date.now());
        if (currentElapsed >= profile.minWaitMs) {
          // 已经等够了 minWaitMs → 触发
          this.resetBatch(groupId);
          callback();
        } else {
          // 还没到 minWaitMs → 再等一会儿
          const remaining = profile.minWaitMs - currentElapsed;
          this.timers.set(
            groupId,
            setTimeout(() => {
              this.resetBatch(groupId);
              callback();
            }, remaining)
          );
        }
      }, this.config.idleMs)
    );
  }

  /**
   * 手动重新启动一个 debounce 周期
   * 用于：上一次处理完成后发现有漏掉的消息
   * bot 刚处理完 → 走 cooldown profile
   */
  restart(groupId: string, callback: () => void): void {
    this.cancelTimer(groupId);
    this.firstMessageTime.set(groupId, Date.now());
    // 不标记 engaged，restart 是普通触发

    const profile = this.selectProfile(groupId);

    this.timers.set(
      groupId,
      setTimeout(() => {
        const elapsed = Date.now() - (this.firstMessageTime.get(groupId) ?? Date.now());
        if (elapsed >= profile.minWaitMs) {
          this.resetBatch(groupId);
          callback();
        } else {
          const remaining = profile.minWaitMs - elapsed;
          this.timers.set(
            groupId,
            setTimeout(() => {
              this.resetBatch(groupId);
              callback();
            }, remaining)
          );
        }
      }, this.config.idleMs)
    );
  }

  /**
   * 重置批次状态
   */
  private resetBatch(groupId: string): void {
    this.firstMessageTime.delete(groupId);
    this.engagedGroups.delete(groupId);
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
    this.lastSpokeAt.clear();
    this.engagedGroups.clear();
  }
}

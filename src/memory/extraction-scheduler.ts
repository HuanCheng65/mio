/**
 * 记忆提取调度器
 *
 * 职责：决定何时触发记忆提取，避免在每次 debounce 后都提取
 *
 * 触发条件：
 * 1. 累积消息数达到阈值（25-40 条）
 * 2. 距上次提取超过最大等待时间（15 分钟）
 * 3. 澪主动参与对话后，累积一定消息数（快速提取通道）
 */

export interface ExtractionSchedulerConfig {
  /** 触发批量提取的最小消息数 */
  minMessages: number;
  /** 最大等待时间（分钟），超过后即使消息不够也提取 */
  maxWaitMinutes: number;
  /** 澪主动参与后，累积多少条消息触发快速提取 */
  activeThreshold: number;
}

export interface ExtractionDecision {
  /** 是否应该触发提取 */
  shouldExtract: boolean;
  /** 触发原因 */
  reason?: 'batch' | 'timeout' | 'active';
  /** 待提取消息数 */
  pendingCount: number;
}

export class MemoryExtractionScheduler {
  /** 每个群未提取的消息计数 */
  private pendingCount = new Map<string, number>();

  /** 每个群上次提取的时间戳 */
  private lastExtractedAt = new Map<string, number>();

  /** 每个群澪最后一次主动参与时的消息计数 */
  private lastActiveMark = new Map<string, number>();

  /** 定时器句柄 */
  private timeoutCheckTimer: NodeJS.Timeout | null = null;

  /** 超时检查回调 */
  private onTimeoutCheck: ((groupId: string) => void) | null = null;

  constructor(private config: ExtractionSchedulerConfig) {}

  /**
   * 记录新消息到达
   * @param groupId 群 ID
   * @param isBot 是否是 bot 自己的消息
   * @returns 提取决策
   */
  onNewMessage(groupId: string, isBot: boolean): ExtractionDecision {
    // 增加计数
    const count = (this.pendingCount.get(groupId) || 0) + 1;
    this.pendingCount.set(groupId, count);

    // 条件 ③：澪主动参与对话
    if (isBot) {
      this.lastActiveMark.set(groupId, count);
    }

    // 检查是否应该触发提取
    const decision = this.checkShouldExtract(groupId);

    return decision;
  }

  /**
   * 检查是否应该触发提取
   */
  private checkShouldExtract(groupId: string): ExtractionDecision {
    const count = this.pendingCount.get(groupId) || 0;
    const lastExtracted = this.lastExtractedAt.get(groupId) || 0;
    const lastActive = this.lastActiveMark.get(groupId);

    // 条件 ①：累积消息数达到阈值
    if (count >= this.config.minMessages) {
      return {
        shouldExtract: true,
        reason: 'batch',
        pendingCount: count,
      };
    }

    // 条件 ③：澪主动参与后的快速提取
    // 只有在澪最近参与过对话，且之后又累积了足够消息时触发
    if (lastActive !== undefined) {
      const messagesSinceActive = count - lastActive;
      if (messagesSinceActive >= this.config.activeThreshold) {
        return {
          shouldExtract: true,
          reason: 'active',
          pendingCount: count,
        };
      }
    }

    // 条件 ②：超时检查（由定时器触发，这里只返回状态）
    const elapsed = Date.now() - lastExtracted;
    const maxWaitMs = this.config.maxWaitMinutes * 60_000;
    if (elapsed > maxWaitMs && count > 0) {
      return {
        shouldExtract: true,
        reason: 'timeout',
        pendingCount: count,
      };
    }

    return {
      shouldExtract: false,
      pendingCount: count,
    };
  }

  /**
   * 标记已完成提取
   * @param groupId 群 ID
   * @param timestamp 最后处理的消息时间戳（不传则使用当前时间）
   */
  markExtracted(groupId: string, timestamp?: number): void {
    this.pendingCount.set(groupId, 0);
    this.lastExtractedAt.set(groupId, timestamp ?? Date.now());
    this.lastActiveMark.delete(groupId);
  }

  /**
   * 获取待提取消息数
   */
  getPendingCount(groupId: string): number {
    return this.pendingCount.get(groupId) || 0;
  }

  /**
   * 获取上次提取时间
   */
  getLastExtractedAt(groupId: string): number {
    return this.lastExtractedAt.get(groupId) || 0;
  }

  /**
   * 启动定时器，定期检查超时的群
   * @param enabledGroups 启用的群列表
   * @param callback 检查到超时时的回调
   */
  startTimeoutChecker(enabledGroups: string[], callback: (groupId: string) => void): void {
    this.onTimeoutCheck = callback;

    // 每 5 分钟检查一次所有群
    const CHECK_INTERVAL_MS = 5 * 60_000;

    this.timeoutCheckTimer = setInterval(() => {
      for (const groupId of enabledGroups) {
        const decision = this.checkShouldExtract(groupId);
        if (decision.shouldExtract && decision.reason === 'timeout') {
          callback(groupId);
        }
      }
    }, CHECK_INTERVAL_MS);
  }

  /**
   * 停止定时器
   */
  dispose(): void {
    if (this.timeoutCheckTimer) {
      clearInterval(this.timeoutCheckTimer);
      this.timeoutCheckTimer = null;
    }
  }

  /**
   * 重置某个群的状态（用于测试或手动干预）
   */
  reset(groupId: string): void {
    this.pendingCount.delete(groupId);
    this.lastExtractedAt.delete(groupId);
    this.lastActiveMark.delete(groupId);
  }

  /**
   * 获取调试信息
   */
  getDebugInfo(groupId: string): {
    pendingCount: number;
    lastExtractedAt: number;
    lastActiveMark: number | undefined;
    timeSinceLastExtraction: number;
  } {
    const lastExtracted = this.lastExtractedAt.get(groupId) || 0;
    return {
      pendingCount: this.pendingCount.get(groupId) || 0,
      lastExtractedAt: lastExtracted,
      lastActiveMark: this.lastActiveMark.get(groupId),
      timeSinceLastExtraction: lastExtracted ? Date.now() - lastExtracted : 0,
    };
  }
}

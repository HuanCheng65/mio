import { Context } from 'koishi'
import { MemoryConfig, MemoryContext } from './types'
import { extendTables } from './tables'
import { EmbeddingService } from './embedding'
import { WorkingMemory } from './working-memory'
import { EpisodicRetriever } from './episodic'
import { ContextAssembler } from './context-assembler'
import { extractMemories } from './extraction'
import { DistillationPipeline } from './distillation'
import { LLMClient } from '../llm/client'
import { ProviderManager } from '../llm/provider'
import { NormalizedMessage } from '../perception/types'
import { ContextRenderer } from '../perception/renderer'
import { updateKnownNames } from './name-learning'

export { MemoryExtractionScheduler } from './extraction-scheduler'

/** record() 的返回摘要 */
export interface RecordSummary {
  worthRemembering: boolean
  episodes: number
  relational: number
  vibes: number
  episodeSummaries: string[]
  relationalSummaries: string[]
  sessionVibes: string[]
}

export class MemoryService {
  private embeddingService: EmbeddingService
  private workingMemory: WorkingMemory
  private episodicRetriever: EpisodicRetriever
  private contextAssembler: ContextAssembler
  private distillation: DistillationPipeline
  private llm: LLMClient
  private config: MemoryConfig
  private distillationTimer: ReturnType<typeof setTimeout> | null = null
  private silentExtractionCounter: Map<string, number> = new Map()
  private renderer = new ContextRenderer()
  private stickerService: any = null

  constructor(
    private ctx: Context,
    providerManager: ProviderManager,
    llm: LLMClient,
    config: MemoryConfig,
  ) {
    this.config = config
    this.llm = llm
    this.embeddingService = new EmbeddingService(providerManager, config.embedding)
    this.workingMemory = new WorkingMemory(ctx, this.embeddingService, config)
    this.episodicRetriever = new EpisodicRetriever(ctx, this.embeddingService, this.workingMemory)
    this.contextAssembler = new ContextAssembler(ctx, this.workingMemory, this.embeddingService)
    this.distillation = new DistillationPipeline(ctx, llm, config, this.embeddingService)
  }

  getEmbeddingService(): EmbeddingService {
    return this.embeddingService
  }

  setStickerService(s: any): void {
    this.stickerService = s
  }

  /**
   * 初始化：建表
   */
  init() {
    extendTables(this.ctx)
  }

  /**
   * 读取路径：获取记忆上下文注入 prompt
   * allBuffered: 整个聊天记录 buffer，用于计算时间窗口过滤
   */
  async getMemoryContext(
    groupId: string,
    participantIds: string[],
    recentMessages: NormalizedMessage[],
    allBuffered?: NormalizedMessage[],
  ): Promise<MemoryContext> {
    const logger = this.ctx.logger('mio.memory')

    try {
      // 取最近几条消息拼接作为检索 query
      const queryText = recentMessages
        .slice(-5)
        .map(m => this.renderer.renderContent(m))
        .join(' ')

      // 聊天记录 buffer 最早消息的时间戳——该时间之后的记忆不注入（已在聊天记录中）
      const chatHistoryStart = allBuffered && allBuffered.length > 0
        ? allBuffered[0].timestamp
        : undefined

      // 混合检索 episodic 记忆
      const memories = await this.episodicRetriever.retrieve(
        groupId, queryText, participantIds, 5, chatHistoryStart,
      )

      // 组装上下文
      return await this.contextAssembler.assemble(groupId, participantIds, memories)
    } catch (err) {
      logger.warn('获取记忆上下文失败:', err)
      return { userProfile: '', memories: '' }
    }
  }

  /**
   * 写入路径：异步提取记忆
   */
  async record(params: {
    groupId: string
    recentMessages: NormalizedMessage[]
    botName: string
  }): Promise<RecordSummary> {
    const logger = this.ctx.logger('mio.memory')

    try {
      const result = await extractMemories(
        this.llm,
        this.config.extraction,
        params.recentMessages,
        params.botName,
        this.ctx,
        params.groupId,
      )

      if (result.worthRemembering) {
        logger.info(
          `提取到 ${result.episodes.length} 条记忆, ` +
          `${result.relationalUpdates.length} 条关系观察, ` +
          `${result.sessionVibes.length} 条情绪`,
        )
      }

      // 称呼观察 → 直接写入 relational 表（不经过 working memory）
      for (const obs of result.nameObservations) {
        try {
          await updateKnownNames(this.ctx, params.groupId, obs.userId, obs.name, obs.source)
          logger.debug(`称呼观察: ${obs.userId} → ${obs.name} (${obs.source})`)
        } catch (err) {
          logger.warn(`更新称呼失败: ${obs.userId}`, err)
        }
      }

      await this.workingMemory.ingest(params.groupId, result)

      return {
        worthRemembering: result.worthRemembering,
        episodes: result.episodes.length,
        relational: result.relationalUpdates.length,
        vibes: result.sessionVibes.length,
        episodeSummaries: result.episodes.map(e =>
          `[imp=${e.importance.toFixed(1)} ${e.mioInvolvement}] ${e.summary}`
        ),
        relationalSummaries: result.relationalUpdates.map(r =>
          `${r.displayName}: ${r.event} (${r.emotionalTone})`
        ),
        sessionVibes: result.sessionVibes.map(v => `[ttl=${v.ttlHours}] ${v.userId}: ${v.vibe}`),
      }
    } catch (err) {
      logger.warn('记忆提取失败:', err)
      return { worthRemembering: false, episodes: 0, relational: 0, vibes: 0, episodeSummaries: [], relationalSummaries: [], sessionVibes: [] }
    }
  }

  /**
   * 清理
   */
  async dispose() {
    this.stopDistillationScheduler()
    this.workingMemory.dispose()
  }

  /**
   * 手动触发蒸馏（也被定时器调用）
   */
  async runDistillation(): Promise<void> {
    await this.distillation.run()
    if (this.stickerService) {
      await this.stickerService.runDailyMaintenance()
      this.ctx.logger('mio.memory').info('表情包日维护完成')
    }
  }

  /**
   * 手动 flush Working Memory
   */
  async flushWorkingMemory(): Promise<void> {
    await this.workingMemory.flush()
  }

  /**
   * 启动每日蒸馏定时器
   */
  startDistillationScheduler(): void {
    const logger = this.ctx.logger('mio.memory')
    const hour = this.config.distillationHour ?? 3

    const scheduleNext = () => {
      const now = new Date()
      const target = new Date(now)
      target.setHours(hour, 0, 0, 0)
      // 如果今天的目标时间已过，设为明天
      if (target.getTime() <= now.getTime()) {
        target.setDate(target.getDate() + 1)
      }
      const delay = target.getTime() - now.getTime()

      logger.info(`下次蒸馏: ${target.toLocaleString('zh-CN')} (${Math.round(delay / 3600_000)}h 后)`)

      this.distillationTimer = setTimeout(async () => {
        try {
          await this.runDistillation()
        } catch (err) {
          logger.error('定时蒸馏失败:', err)
        }
        // 执行完后安排下一次
        scheduleNext()
      }, delay)
    }

    scheduleNext()
  }

  private stopDistillationScheduler(): void {
    if (this.distillationTimer) {
      clearTimeout(this.distillationTimer)
      this.distillationTimer = null
    }
  }
}

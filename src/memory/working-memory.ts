import { Context } from 'koishi'
import {
  SessionVibe,
  ExtractionResult,
  MemoryConfig,
} from './types'
import { EmbeddingService, cosineSimilarity } from './embedding'

interface PendingEpisodic {
  groupId: string
  summary: string
  participants: string[]
  tags: string[]
  embedding: number[]
  importance: number
  emotionalValence: number
  emotionalIntensity: number
  mioInvolvement: 'active' | 'observer' | 'mentioned'
  eventTime: number
}

export class WorkingMemory {
  private pendingEpisodic: PendingEpisodic[] = []
  private sessionVibes: Map<string, SessionVibe> = new Map()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private config: MemoryConfig

  constructor(
    private ctx: Context,
    private embeddingService: EmbeddingService,
    config: MemoryConfig,
  ) {
    this.config = config
  }

  /**
   * 接收提取结果，写入内存缓冲（仅 episodic + vibes）
   */
  async ingest(groupId: string, result: ExtractionResult): Promise<void> {
    if (!result.worthRemembering) return

    const logger = this.ctx.logger('mio.memory')
    const now = Date.now()

    // 生成 embedding（批量）
    if (result.episodes.length > 0) {
      try {
        const summaries = result.episodes.map(e => e.summary)
        const embeddings = await this.embeddingService.embedBatch(summaries)

        // 加载数据库中该群的最近记忆（用于去重）
        const recentDbEpisodes = await this.ctx.database.get('mio.episodic', {
          groupId,
          archived: false,
        })

        for (let i = 0; i < result.episodes.length; i++) {
          const ep = result.episodes[i]
          const newEmbedding = embeddings[i]

          // 去重 1: 检查和已有 pending 记忆的相似度
          const isDuplicateInPending = this.pendingEpisodic.some(existing =>
            existing.groupId === groupId &&
            existing.embedding.length > 0 &&
            cosineSimilarity(newEmbedding, existing.embedding) > 0.9
          )
          if (isDuplicateInPending) {
            logger.debug(`跳过重复记忆 (pending): ${ep.summary.slice(0, 30)}...`)
            continue
          }

          // 去重 2: 检查和数据库中记忆的相似度
          const isDuplicateInDb = recentDbEpisodes.some(existing =>
            existing.embedding && existing.embedding.length > 0 &&
            cosineSimilarity(newEmbedding, existing.embedding) > 0.9
          )
          if (isDuplicateInDb) {
            logger.debug(`跳过重复记忆 (db): ${ep.summary.slice(0, 30)}...`)
            continue
          }

          this.pendingEpisodic.push({
            groupId,
            summary: ep.summary,
            participants: ep.participants,
            tags: ep.tags,
            embedding: newEmbedding,
            importance: ep.importance,
            emotionalValence: ep.emotionalValence,
            emotionalIntensity: ep.emotionalIntensity,
            mioInvolvement: ep.mioInvolvement,
            eventTime: now,
          })
        }
        logger.debug(`缓冲 ${result.episodes.length} 条 episodic 记忆`)
      } catch (err) {
        logger.warn('生成 embedding 失败:', err)
      }
    }

    // Session vibes（直接生效）
    for (const vibe of result.sessionVibes) {
      const key = `${groupId}:${vibe.userId}`
      this.sessionVibes.set(key, {
        userId: vibe.userId,
        vibe: vibe.vibe,
        expiresAt: now + vibe.ttlHours * 3600_000,
      })
    }

    this.resetFlushTimer()

    // 积累过多时立即 flush
    if (this.pendingEpisodic.length >= this.config.maxPendingWrites) {
      await this.flush()
    }
  }

  /**
   * 获取某群的 pending episodic 记忆
   */
  getPendingEpisodic(groupId: string): PendingEpisodic[] {
    return this.pendingEpisodic.filter(e => e.groupId === groupId)
  }

  /**
   * 获取某用户的 session vibe（检查过期）
   */
  getSessionVibe(groupId: string, userId: string): SessionVibe | null {
    const key = `${groupId}:${userId}`
    const vibe = this.sessionVibes.get(key)
    if (!vibe) return null
    if (Date.now() > vibe.expiresAt) {
      this.sessionVibes.delete(key)
      return null
    }
    return vibe
  }

  /**
   * 批量写入 SQLite（仅 episodic）
   */
  async flush(): Promise<void> {
    const logger = this.ctx.logger('mio.memory')
    if (this.pendingEpisodic.length === 0) return

    const epCount = this.pendingEpisodic.length
    const now = Date.now()

    try {
      for (const ep of this.pendingEpisodic) {
        await this.ctx.database.create('mio.episodic', {
          groupId: ep.groupId,
          summary: ep.summary,
          participants: ep.participants,
          tags: ep.tags,
          embedding: ep.embedding,
          importance: ep.importance,
          emotionalValence: ep.emotionalValence,
          emotionalIntensity: ep.emotionalIntensity,
          mioInvolvement: ep.mioInvolvement,
          eventTime: ep.eventTime,
          archived: false,
          createdAt: now,
        })
      }

      this.pendingEpisodic = []
      logger.info(`Flush 完成: ${epCount} episodic`)
    } catch (err) {
      logger.error('Flush 失败:', err)
    }
  }

  private resetFlushTimer() {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => this.flush(), this.config.flushIntervalMs)
  }

  dispose() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    // 同步 flush 不可能，但尝试一下
    this.flush().catch(() => {})
  }
}

import { Context } from 'koishi'
import { EmbeddingService, cosineSimilarity } from './embedding'
import { WorkingMemory } from './working-memory'

export interface RetrievedMemory {
  summary: string
  tags: string[]
  eventTime: number
  importance: number
  mioInvolvement: string
  score: number
}

export class EpisodicRetriever {
  constructor(
    private ctx: Context,
    private embeddingService: EmbeddingService,
    private workingMemory: WorkingMemory,
  ) {}

  /**
   * 混合检索：embedding 相似度 + 时间衰减 + importance + tag 匹配
   * 返回 top-5 最相关的记忆
   * chatHistoryStart: 聊天记录最早消息的时间戳，该时间之后的记忆不注入（已在聊天记录中）
   */
  async retrieve(
    groupId: string,
    recentText: string,
    participantIds: string[],
    topK: number = 5,
    chatHistoryStart?: number,
  ): Promise<RetrievedMemory[]> {
    const logger = this.ctx.logger('mio.memory')

    // 生成查询 embedding
    let queryEmbedding: number[]
    try {
      queryEmbedding = await this.embeddingService.embed(recentText)
    } catch (err) {
      logger.warn('生成查询 embedding 失败:', err)
      return []
    }

    // 从 DB 加载该群所有非 archived 的 episodic 记忆
    const dbRows = await this.ctx.database.get('mio.episodic', {
      groupId,
      archived: false,
    })

    // 合并 working memory 中的 pending
    const pending = this.workingMemory.getPendingEpisodic(groupId)

    const now = Date.now()
    const queryLower = recentText.toLowerCase()
    const candidates: RetrievedMemory[] = []

    // 评分 DB 记忆
    for (const row of dbRows) {
      // 跳过聊天记录已覆盖的时间范围内的记忆
      if (chatHistoryStart && row.eventTime >= chatHistoryStart) continue

      const embedding = row.embedding
      if (!embedding || embedding.length === 0) continue

      const similarity = cosineSimilarity(queryEmbedding, embedding)
      const daysSince = (now - row.eventTime) / 86400_000
      const timeDecay = Math.pow(0.5, daysSince / 7) // 7 天半衰期
      const tagBoost = (row.tags || []).some(tag => queryLower.includes(tag.toLowerCase())) ? 0.15 : 0
      const score = similarity * 0.5 + timeDecay * 0.2 + row.importance * 0.1 + tagBoost * 0.2

      candidates.push({
        summary: row.summary,
        tags: row.tags || [],
        eventTime: row.eventTime,
        importance: row.importance,
        mioInvolvement: row.mioInvolvement,
        score,
      })
    }

    // 评分 pending 记忆
    for (const ep of pending) {
      // 跳过聊天记录已覆盖的时间范围内的记忆
      if (chatHistoryStart && ep.eventTime >= chatHistoryStart) continue

      if (!ep.embedding || ep.embedding.length === 0) continue

      const similarity = cosineSimilarity(queryEmbedding, ep.embedding)
      const daysSince = (now - ep.eventTime) / 86400_000
      const timeDecay = Math.pow(0.5, daysSince / 7)
      const tagBoost = (ep.tags || []).some(tag => queryLower.includes(tag.toLowerCase())) ? 0.15 : 0
      const score = similarity * 0.5 + timeDecay * 0.2 + ep.importance * 0.1 + tagBoost * 0.2

      candidates.push({
        summary: ep.summary,
        tags: ep.tags || [],
        eventTime: ep.eventTime,
        importance: ep.importance,
        mioInvolvement: ep.mioInvolvement,
        score,
      })
    }

    // 排序取 top-K
    candidates.sort((a, b) => b.score - a.score)
    const results = candidates.slice(0, topK)

    logger.debug(`检索到 ${results.length} 条相关记忆 (候选 ${candidates.length})`)
    return results
  }
}

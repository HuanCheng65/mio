import { Context } from 'koishi'
import { ExtractionCulturalObservation, CulturalObservationType } from './types'
import { EmbeddingService, cosineSimilarity } from './embedding'

const TYPE_TO_FACT_TYPE: Record<CulturalObservationType, string> = {
  expression: 'group_expression',
  reaction_pattern: 'reaction_pattern',
  tool_knowledge: 'tool_knowledge',
  meme: 'inside_joke',
}

const DEDUP_THRESHOLD = 0.85
const MAX_CONFIDENCE = 0.8
const CONFIDENCE_BUMP = 0.1

/**
 * 处理文化观察：直达 semantic 写入（类似 name-learning.ts 模式）
 * - 为每条观察生成 embedding
 * - 与已有 group facts 去重（cosine >= 0.85）
 *   - 重复：bump confidence +0.1（cap 0.8）
 *   - 新增：写入 mio.semantic，初始 confidence 来自提取
 */
export async function processCulturalObservations(
  ctx: Context,
  groupId: string,
  observations: ExtractionCulturalObservation[],
  embeddingService: EmbeddingService,
): Promise<string[]> {
  if (observations.length === 0) return []

  const logger = ctx.logger('mio.culture')
  const summaries: string[] = []

  // 加载所有已有的 group facts
  const existingFacts = await ctx.database.get('mio.semantic', {
    groupId,
    subject: 'group',
  })
  const activeFacts = existingFacts.filter(
    f => f.supersededBy === null || f.supersededBy === undefined,
  )

  // 批量生成 embedding
  const texts = observations.map(o => o.content)
  let embeddings: number[][]
  try {
    embeddings = await embeddingService.embedBatch(texts)
  } catch (err) {
    logger.warn('文化观察 embedding 生成失败:', err)
    return []
  }

  const now = Date.now()

  for (let i = 0; i < observations.length; i++) {
    const obs = observations[i]
    const embedding = embeddings[i]
    const factType = TYPE_TO_FACT_TYPE[obs.type]

    // 与已有 facts 去重
    let matched = false
    for (const fact of activeFacts) {
      if (fact.embedding && fact.embedding.length > 0) {
        const similarity = cosineSimilarity(embedding, fact.embedding)
        if (similarity >= DEDUP_THRESHOLD) {
          // 重复：bump confidence
          const newConfidence = Math.min(MAX_CONFIDENCE, fact.confidence + CONFIDENCE_BUMP)
          await ctx.database.set('mio.semantic', { id: fact.id }, {
            confidence: newConfidence,
            lastConfirmed: now,
          })
          logger.debug(`文化观察去重合并: "${obs.content}" → fact#${fact.id} (${fact.confidence.toFixed(2)} → ${newConfidence.toFixed(2)})`)
          summaries.push(`合并: ${obs.content} (${newConfidence.toFixed(2)})`)
          matched = true
          // 更新内存中的 confidence 以避免后续重复 bump
          fact.confidence = newConfidence
          break
        }
      }
    }

    if (!matched) {
      // 新增 fact
      await ctx.database.create('mio.semantic', {
        groupId,
        subject: 'group',
        factType,
        content: obs.content,
        embedding,
        confidence: obs.confidence,
        sourceEpisodes: [],
        firstObserved: now,
        lastConfirmed: now,
        supersededBy: null,
        createdAt: now,
      })
      logger.debug(`新文化观察写入: [${obs.type}] "${obs.content}" (confidence=${obs.confidence.toFixed(2)})`)
      summaries.push(`新增: ${obs.content} (${obs.confidence.toFixed(2)})`)
    }
  }

  return summaries
}

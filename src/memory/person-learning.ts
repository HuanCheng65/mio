import { Context } from 'koishi'
import { ExtractionRelUpdate, ClosenessTier } from './types'
import { EmbeddingService, cosineSimilarity } from './embedding'

const DEDUP_THRESHOLD = 0.85
const MAX_CONFIDENCE = 0.8
const CONFIDENCE_BUMP = 0.1

/**
 * 处理人物观察：直达 semantic + relational 写入（类似 culture-learning.ts 模式）
 *
 * Part A — 语义事实直写：
 *   按 userId 分组，加载已有 facts，embedding 去重，新增或 bump
 *
 * Part B — 关系元数据更新：
 *   递增 interactionCount，更新 lastInteraction、displayName、closenessTier
 */
export async function processPersonObservations(
  ctx: Context,
  groupId: string,
  observations: ExtractionRelUpdate[],
  embeddingService: EmbeddingService,
): Promise<string[]> {
  if (observations.length === 0) return []

  const logger = ctx.logger('mio.person')
  const summaries: string[] = []
  const now = Date.now()

  // 按 userId 分组
  const byUser = new Map<string, ExtractionRelUpdate[]>()
  for (const obs of observations) {
    const list = byUser.get(obs.userId) || []
    list.push(obs)
    byUser.set(obs.userId, list)
  }

  for (const [userId, userObs] of byUser) {
    // === Part A: 语义事实直写 ===
    const existingFacts = await ctx.database.get('mio.semantic', {
      groupId,
      subject: userId,
    })
    const activeFacts = existingFacts.filter(
      f => f.supersededBy === null || f.supersededBy === undefined,
    )

    // 批量生成 embedding
    const texts = userObs.map(o => o.event)
    let embeddings: number[][]
    try {
      embeddings = await embeddingService.embedBatch(texts)
    } catch (err) {
      logger.warn(`人物观察 embedding 生成失败 (${userId}):`, err)
      embeddings = userObs.map(() => [])
    }

    for (let i = 0; i < userObs.length; i++) {
      const obs = userObs[i]
      const embedding = embeddings[i]

      if (embedding.length === 0) continue

      // 去重：cosine >= 0.85 → bump confidence
      let matched = false
      for (const fact of activeFacts) {
        if (fact.embedding && fact.embedding.length > 0) {
          const similarity = cosineSimilarity(embedding, fact.embedding)
          if (similarity >= DEDUP_THRESHOLD) {
            const newConfidence = Math.min(MAX_CONFIDENCE, fact.confidence + CONFIDENCE_BUMP)
            await ctx.database.set('mio.semantic', { id: fact.id }, {
              confidence: newConfidence,
              lastConfirmed: now,
            })
            logger.debug(`人物观察去重合并: "${obs.event}" → fact#${fact.id} (${fact.confidence.toFixed(2)} → ${newConfidence.toFixed(2)})`)
            summaries.push(`${obs.displayName}: 合并 "${obs.event}" (${newConfidence.toFixed(2)})`)
            matched = true
            fact.confidence = newConfidence
            break
          }
        }
      }

      if (!matched) {
        // confidence 从 importance 映射
        const confidence = obs.importance >= 0.7 ? 0.6
          : obs.importance >= 0.4 ? 0.5
          : 0.4

        await ctx.database.create('mio.semantic', {
          groupId,
          subject: userId,
          factType: 'trait',
          content: obs.event,
          embedding,
          confidence,
          sourceEpisodes: [],
          firstObserved: now,
          lastConfirmed: now,
          supersededBy: null,
          createdAt: now,
        })
        logger.debug(`新人物观察写入: [${userId}] "${obs.event}" (confidence=${confidence})`)
        summaries.push(`${obs.displayName}: 新增 "${obs.event}" (${confidence})`)
      }
    }

    // === Part B: 关系元数据更新 ===
    const existing = await ctx.database.get('mio.relational', {
      groupId,
      userId,
    })

    const latestDisplayName = userObs[userObs.length - 1].displayName

    if (existing.length > 0) {
      const record = existing[0]
      const newCount = record.interactionCount + userObs.length
      const tier = computeClosenessTier(
        newCount,
        record.lastInteraction,
        (record.closenessTier || 'stranger') as ClosenessTier,
      )

      await ctx.database.set('mio.relational', { id: record.id }, {
        displayName: latestDisplayName,
        interactionCount: newCount,
        lastInteraction: now,
        closenessTier: tier,
        updatedAt: now,
      })
    } else {
      await ctx.database.create('mio.relational', {
        groupId,
        userId,
        displayName: latestDisplayName,
        coreImpression: '',
        coreImpressionUpdatedAt: now,
        recentImpression: '',
        recentImpressionUpdatedAt: now,
        closenessTier: 'stranger',
        interactionCount: userObs.length,
        lastInteraction: now,
        knownNames: '[]',
        preferredName: null,
        createdAt: now,
        updatedAt: now,
      })
    }
  }

  return summaries
}

function computeClosenessTier(
  total: number,
  lastInteraction: number,
  currentTier: ClosenessTier,
): ClosenessTier {
  const daysSince = (Date.now() - lastInteraction) / 86400_000

  // 30 天无互动：降一级
  if (daysSince > 30) {
    const downgradeMap: Record<ClosenessTier, ClosenessTier> = {
      close: 'familiar',
      familiar: 'acquaintance',
      acquaintance: 'stranger',
      stranger: 'stranger',
    }
    return downgradeMap[currentTier]
  }

  if (total >= 50) return 'close'
  if (total >= 15) return 'familiar'
  if (total >= 3) return 'acquaintance'
  return 'stranger'
}

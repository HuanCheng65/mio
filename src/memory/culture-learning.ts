import { Context } from 'koishi'
import { ExtractionCulturalObservation, CulturalObservationType, CultureEvidenceKind } from './types'
import { EmbeddingService, cosineSimilarity } from './embedding'

const TYPE_TO_KIND: Record<CulturalObservationType, CultureEvidenceKind> = {
  expression: 'group_expression',
  reaction_pattern: 'reaction_pattern',
  tool_knowledge: 'tool_knowledge',
  meme: 'inside_joke',
}

const DEDUP_THRESHOLD = 0.95
const MAX_CONFIDENCE = 0.9
const CONFIDENCE_BUMP = 0.1

/**
 * 处理文化观察：写入 evidence 层，保留轻量同窗去重
 * - 为每条观察生成 embedding
 * - 仅在传入的同一批次/时间窗 key 内做轻量去重
 * - meme 统一归一化为 inside_joke
 */
export async function processCulturalObservations(
  ctx: Context,
  groupId: string,
  observations: ExtractionCulturalObservation[],
  embeddingService: EmbeddingService,
  sourceWindowKey: string,
): Promise<string[]> {
  if (observations.length === 0) return []

  const logger = ctx.logger('mio.culture')
  const summaries: string[] = []
  const now = Date.now()

  // 仅加载同窗内已有 evidence，避免同一次批次反复写入
  const existingEvidence = await ctx.database.get('mio.culture_evidence', {
    groupId,
    sourceWindowKey,
  })
  const windowEvidence = existingEvidence.filter(
    e => e.status === 'active' || e.status === 'promoted' || e.status === undefined,
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

  for (let i = 0; i < observations.length; i++) {
    const obs = observations[i]
    const embedding = embeddings[i]
    const kind = TYPE_TO_KIND[obs.type]
    const content = obs.content.trim()

    // 轻量同窗去重：同 kind + 高相似 / 同文本，只合并到 evidence 层
    let matched = false
    for (const evidence of windowEvidence) {
      if (evidence.kind !== kind) continue

      if (evidence.content === content) {
        const newConfidence = Math.min(MAX_CONFIDENCE, evidence.confidence + CONFIDENCE_BUMP)
        await ctx.database.set('mio.culture_evidence', { id: evidence.id }, {
          confidence: newConfidence,
          lastSeenAt: now,
        })
        logger.debug(`文化证据去重合并(同窗同文): "${content}" → evidence#${evidence.id}`)
        summaries.push(`合并: ${content} (${newConfidence.toFixed(2)})`)
        evidence.confidence = newConfidence
        evidence.lastSeenAt = now
        matched = true
        break
      }

      if (evidence.embedding && evidence.embedding.length > 0) {
        const similarity = cosineSimilarity(embedding, evidence.embedding)
        if (similarity >= DEDUP_THRESHOLD) {
          const newConfidence = Math.min(MAX_CONFIDENCE, evidence.confidence + CONFIDENCE_BUMP)
          await ctx.database.set('mio.culture_evidence', { id: evidence.id }, {
            confidence: newConfidence,
            lastSeenAt: now,
          })
          logger.debug(
            `文化证据去重合并: "${content}" → evidence#${evidence.id} (${evidence.confidence.toFixed(2)} → ${newConfidence.toFixed(2)})`,
          )
          summaries.push(`合并: ${content} (${newConfidence.toFixed(2)})`)
          evidence.confidence = newConfidence
          evidence.lastSeenAt = now
          matched = true
          break
        }
      }
    }

    if (!matched) {
      const created = await ctx.database.create('mio.culture_evidence', {
        groupId,
        kind,
        content,
        embedding,
        confidence: obs.confidence,
        sourceEpisodeId: null,
        sourceWindowKey,
        observedAt: now,
        lastSeenAt: now,
        status: 'active',
        clusterId: null,
        createdAt: now,
      })
      windowEvidence.push(created)
      logger.debug(`新文化证据写入: [${obs.type}] "${content}" (confidence=${obs.confidence.toFixed(2)})`)
      summaries.push(`新增: ${content} (${obs.confidence.toFixed(2)})`)
    }
  }

  return summaries
}

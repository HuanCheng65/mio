import { Logger } from 'koishi'
import { EmbeddingService } from '../memory/embedding'
import { StickerDB, ScoredSticker } from './db'
import { MioStickerRow } from '../memory/tables'

const W = {
  VIBE: 0.25,
  SCENE: 0.20,
  CONTENT: 0.15,
  FREQUENCY: 0.15,
  FRESHNESS: 0.10,
  QUALITY: 0.10,
  REPEAT: 0.05,
}

const RELEVANCE_THRESHOLD = 0.45

export class StickerRetrieval {
  constructor(
    private db: StickerDB,
    private embedding: EmbeddingService,
    private logger: Logger,
  ) {}

  async resolveSticker(intent: string): Promise<{ imagePath: string; description: string } | null> {
    // Query cleaning: remove words that appear in every indexed entry and inflate similarity
    const cleanIntent = intent
      .replace(/表情包?|图片?|的样子/g, '')
      .trim()

    if (!cleanIntent) {
      this.logger.debug(`检索词清洗后为空，跳过检索 (原始: "${intent}")`)
      return null
    }

    this.logger.debug(`检索意图: "${intent}" → "${cleanIntent}"`)

    const intentVec = await this.embedding.embed(cleanIntent)

    const [vibeResults, sceneResults, contentResults] = await Promise.all([
      this.db.searchByEmbedding('vibe_embedding', intentVec, 10),
      this.db.searchByEmbedding('scene_embedding', intentVec, 10),
      this.db.searchByEmbedding('content_embedding', intentVec, 10),
    ])

    // Merge: keep the highest similarity per path for each sticker
    const merged = new Map<string, ScoredSticker>()
    for (const s of [...vibeResults, ...sceneResults, ...contentResults]) {
      const prev = merged.get(s.id)
      if (!prev) {
        merged.set(s.id, { ...s })
      } else {
        merged.set(s.id, {
          ...prev,
          vibe_similarity: Math.max(prev.vibe_similarity ?? 0, s.vibe_similarity ?? 0),
          scene_similarity: Math.max(prev.scene_similarity ?? 0, s.scene_similarity ?? 0),
          content_similarity: Math.max(prev.content_similarity ?? 0, s.content_similarity ?? 0),
        })
      }
    }

    const candidates = Array.from(merged.values())
    this.logger.debug(`三路检索: vibe=${vibeResults.length} scene=${sceneResults.length} content=${contentResults.length} → merged=${candidates.length} (intent: "${intent}")`)

    if (candidates.length === 0) {
      this.logger.debug(`检索无候选`)
      return null
    }

    const ranked = this.rerank(candidates, intent)
    const best = ranked[0]

    const relevance = (best.vibe_similarity ?? 0) * 0.40
                    + (best.scene_similarity ?? 0) * 0.30
                    + (best.content_similarity ?? 0) * 0.30

    if (relevance < RELEVANCE_THRESHOLD) {
      this.logger.debug(`最佳匹配相关度不足: "${best.description.slice(0, 30)}" relevance=${relevance.toFixed(3)} < ${RELEVANCE_THRESHOLD}`)
      return null
    }

    this.logger.debug(`检索命中: "${best.description.slice(0, 40)}" relevance=${relevance.toFixed(3)} finalScore=${best.finalScore?.toFixed(3)}`)
    await this.db.recordUse(best.id)
    return { imagePath: best.image_path, description: best.description }
  }

  private rerank(candidates: ScoredSticker[], intent: string): ScoredSticker[] {
    const now = Date.now()
    const keywords = intent.split(/[\s,，、.]+/).filter(k => k.length > 0)

    return candidates.map(s => {
      let matchCount = 0
      const targetText = (s.vibe_tags.join(' ') + ' ' + s.description).toLowerCase()
      for (const k of keywords) {
        if (targetText.includes(k.toLowerCase())) matchCount++
      }
      const keywordScore = Math.min(matchCount * 0.15, 0.45)

      return {
        ...s,
        finalScore: (s.vibe_similarity ?? 0) * W.VIBE
          + (s.scene_similarity ?? 0) * W.SCENE
          + (s.content_similarity ?? 0) * W.CONTENT
          + frequencyBonus(s) * W.FREQUENCY
          + freshnessBonus(s, now) * W.FRESHNESS
          + s.quality_score * W.QUALITY
          - recentRepeatPenalty(s, now) * W.REPEAT
          + keywordScore,
      }
    }).sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0))
  }
}

function frequencyBonus(s: MioStickerRow): number {
  if (s.use_count === 0) return 0
  return Math.min(Math.log(s.use_count + 1) / Math.log(20), 1.0)
}

function freshnessBonus(s: MioStickerRow, now: number): number {
  const days = (now - s.collected_at) / 86400000
  if (days <= 3) return 1.0
  if (days <= 7) return (7 - days) / 4
  return 0
}

function recentRepeatPenalty(s: MioStickerRow, now: number): number {
  if (!s.last_used) return 0
  const hours = (now - s.last_used) / 3600000
  if (hours < 1) return 1.0
  if (hours < 24) return (24 - hours) / 24
  return 0
}

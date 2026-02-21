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
  ) {}

  async resolveSticker(intent: string): Promise<string | null> {
    const intentVec = await this.embedding.embed(intent)

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
    if (candidates.length === 0) return null

    const ranked = this.rerank(candidates)
    const best = ranked[0]

    const relevance = (best.vibe_similarity ?? 0) * 0.40
                    + (best.scene_similarity ?? 0) * 0.30
                    + (best.content_similarity ?? 0) * 0.30

    if (relevance < RELEVANCE_THRESHOLD) return null

    await this.db.recordUse(best.id)
    return best.image_path
  }

  private rerank(candidates: ScoredSticker[]): ScoredSticker[] {
    const now = Date.now()
    return candidates.map(s => ({
      ...s,
      finalScore: (s.vibe_similarity ?? 0) * W.VIBE
        + (s.scene_similarity ?? 0) * W.SCENE
        + (s.content_similarity ?? 0) * W.CONTENT
        + frequencyBonus(s) * W.FREQUENCY
        + freshnessBonus(s, now) * W.FRESHNESS
        + s.quality_score * W.QUALITY
        - recentRepeatPenalty(s, now) * W.REPEAT,
    })).sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0))
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

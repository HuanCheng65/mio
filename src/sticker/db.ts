import { Context } from 'koishi'
import { MioStickerRow } from '../memory/tables'
import { cosineSimilarity } from '../memory/embedding'

export interface ScoredSticker extends MioStickerRow {
  vibe_similarity?: number
  scene_similarity?: number
  content_similarity?: number
  finalScore?: number
}

export class StickerDB {
  constructor(private ctx: Context) {}

  async insert(row: MioStickerRow): Promise<void> {
    await this.ctx.database.create('mio.sticker', row)
  }

  async findByPhash(phash: string, threshold = 8): Promise<MioStickerRow | null> {
    const all = await this.ctx.database.get('mio.sticker', {})
    for (const s of all) {
      if (hammingDistance(phash, s.phash) < threshold) return s
    }
    return null
  }

  async incrementEncounterCount(id: string): Promise<void> {
    const rows = await this.ctx.database.get('mio.sticker', { id })
    if (rows.length === 0) return
    await this.ctx.database.set('mio.sticker', { id }, {
      encounter_count: rows[0].encounter_count + 1,
    })
  }

  async getActiveStickers(): Promise<MioStickerRow[]> {
    return this.ctx.database.get('mio.sticker', { status: 'active' })
  }

  async countActiveStickers(): Promise<number> {
    const rows = await this.ctx.database.get('mio.sticker', { status: 'active' })
    return rows.length
  }

  async searchByEmbedding(
    field: 'vibe_embedding' | 'scene_embedding' | 'content_embedding',
    queryVec: number[],
    topK = 10,
  ): Promise<ScoredSticker[]> {
    const active = await this.getActiveStickers()
    const simKey = field.replace('_embedding', '_similarity') as
      'vibe_similarity' | 'scene_similarity' | 'content_similarity'

    return active
      .map(s => ({ ...s, [simKey]: cosineSimilarity(s[field], queryVec) } as ScoredSticker))
      .sort((a, b) => ((b[simKey] ?? 0) - (a[simKey] ?? 0)))
      .slice(0, topK)
  }

  async recordUse(id: string): Promise<void> {
    const rows = await this.ctx.database.get('mio.sticker', { id })
    if (rows.length === 0) return
    await this.ctx.database.set('mio.sticker', { id }, {
      use_count: rows[0].use_count + 1,
      last_used: Date.now(),
    })
  }

  async archiveSticker(id: string): Promise<void> {
    await this.ctx.database.set('mio.sticker', { id }, { status: 'archived' })
  }

  async updateQualityScore(id: string, score: number): Promise<void> {
    await this.ctx.database.set('mio.sticker', { id }, { quality_score: score })
  }
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Infinity
  let dist = 0
  for (let i = 0; i < a.length; i++) {
    const xor = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    // count set bits
    let n = xor
    while (n) { dist += n & 1; n >>= 1 }
  }
  return dist
}

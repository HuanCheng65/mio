import { Logger } from 'koishi'
import { StickerDB } from './db'
import { cosineSimilarity } from '../memory/embedding'
import { MioStickerRow } from '../memory/tables'

export class StickerMaintenance {
  constructor(
    private db: StickerDB,
    private logger: Logger,
  ) {}

  async runDaily(): Promise<void> {
    const active = await this.db.getActiveStickers()
    let updated = 0
    for (const s of active) {
      const newScore = updateQualityScore(s)
      if (Math.abs(newScore - s.quality_score) > 0.001) {
        await this.db.updateQualityScore(s.id, newScore)
        updated++
      }
    }
    this.logger.debug(`日维护完成：共 ${active.length} 张，更新评分 ${updated} 张`)
  }

  async runWeeklyDedup(): Promise<void> {
    const active = await this.db.getActiveStickers()
    const archived = new Set<string>()

    for (let i = 0; i < active.length; i++) {
      if (archived.has(active[i].id)) continue
      for (let j = i + 1; j < active.length; j++) {
        if (archived.has(active[j].id)) continue
        const vibeSim = cosineSimilarity(
          active[i].vibe_embedding, active[j].vibe_embedding,
        )
        const styleOvlp = tagOverlap(active[i].style_tags, active[j].style_tags)
        if (vibeSim > 0.90 && styleOvlp > 0.7) {
          const loser = active[i].quality_score < active[j].quality_score
            ? active[i] : active[j]
          if (loser.use_count < 5) {
            await this.db.archiveSticker(loser.id)
            archived.add(loser.id)
          }
        }
      }
    }
    this.logger.debug(`周去重完成：归档 ${archived.size} 张，剩余活跃 ${active.length - archived.size} 张`)
  }

  async generateSummary(): Promise<string> {
    const active = await this.db.getActiveStickers()
    if (active.length === 0) return ''

    const topStyles = topN(countTags(active, 'style_tags'), 3)
    const topVibes = topN(countTags(active, 'vibe_tags'), 5)
    const recent = active
      .filter(s => Date.now() - s.collected_at < 3 * 86400000)
      .sort((a, b) => b.collected_at - a.collected_at)
      .slice(0, 2)

    const lines: string[] = [`你的表情包收藏（${active.length} 张）：`]
    if (topStyles.length > 0) lines.push(`- 风格以${topStyles.join('、')}为主`)
    if (topVibes.length > 0) lines.push(`- 常见情绪：${topVibes.join('、')}`)
    if (recent.length > 0) {
      const desc = recent.map(s => `[${s.description.slice(0, 20)}]`).join('、')
      lines.push(`- 最近新收了几张：${desc}`)
    }
    return lines.join('\n')
  }
}

function updateQualityScore(s: MioStickerRow): number {
  let score = s.quality_score
  if (s.use_count > 0) {
    const useSignal = Math.min(s.use_count / 10, 0.2)
    score = score * 0.8 + (score + useSignal) * 0.2
  }
  const lastAction = s.last_used ?? s.collected_at
  const daysSince = (Date.now() - lastAction) / 86400000
  if (daysSince > 14) score *= 0.95
  if (s.encounter_count > 3) score = Math.max(score, 0.5)
  return Math.max(score, 0.05)
}

function tagOverlap(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1
  const setA = new Set(a)
  const intersection = b.filter(t => setA.has(t)).length
  return intersection / Math.max(a.length, b.length)
}

function countTags(stickers: MioStickerRow[], field: 'style_tags' | 'vibe_tags'): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const s of stickers) {
    for (const tag of s[field]) {
      counts[tag] = (counts[tag] ?? 0) + 1
    }
  }
  return counts
}

function topN(counts: Record<string, number>, n: number): string[] {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([tag]) => tag)
}

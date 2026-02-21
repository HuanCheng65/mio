import { Context } from 'koishi'
import { NameObservation } from './types'

/**
 * 从 semantic fact 内容中解析称呼信息
 */
export function parseNameFromFact(factContent: string): { name: string; source: 'others_call' | 'self_intro' } | null {
  // 匹配模式：
  // "大家都叫他XXX 他自己也这么介绍的" → name="XXX", source="self_intro"
  // "群里好像都叫他XXX" → name="XXX", source="others_call"

  const selfIntroPattern = /(?:大家|群里|都)(?:都)?叫他([^\s，。]+).*(?:他自己也|自己介绍|自我介绍)/
  const othersCallPattern = /(?:大家|群里|都)(?:都)?叫他([^\s，。]+)/

  const selfIntroMatch = factContent.match(selfIntroPattern)
  if (selfIntroMatch) {
    return { name: selfIntroMatch[1].trim(), source: 'self_intro' }
  }

  const othersCallMatch = factContent.match(othersCallPattern)
  if (othersCallMatch) {
    return { name: othersCallMatch[1].trim(), source: 'others_call' }
  }

  return null
}

/**
 * 解析 preferred_name 并选择最佳称呼
 */
export function resolvePreferredName(observations: NameObservation[]): string | null {
  if (observations.length === 0) return null

  // self_intro 优先级最高
  const selfIntro = observations.find(o => o.source === 'self_intro')
  if (selfIntro) return selfIntro.name

  // 否则取 others_call 中 count 最高的
  const byOthers = observations
    .filter(o => o.source === 'others_call')
    .sort((a, b) => b.count - a.count)
  if (byOthers.length && byOthers[0].count >= 2) return byOthers[0].name

  // 还没有足够信号，不强行取名
  return null
}

/**
 * 更新用户的已知称呼
 */
export async function updateKnownNames(
  ctx: Context,
  groupId: string,
  userId: string,
  factContent: string,
): Promise<void> {
  const parsed = parseNameFromFact(factContent)
  if (!parsed) return

  const rows = await ctx.database.get('mio.relational', { groupId, userId })
  if (rows.length === 0) return

  const rel = rows[0]
  const names: NameObservation[] = JSON.parse(rel.knownNames || '[]')

  const existing = names.find(n => n.name === parsed.name)
  const now = Date.now()

  if (existing) {
    existing.count++
    existing.lastSeen = now
    if (parsed.source === 'self_intro') existing.source = 'self_intro'
  } else {
    names.push({
      name: parsed.name,
      source: parsed.source,
      count: 1,
      firstSeen: now,
      lastSeen: now,
    })
  }

  const preferred = resolvePreferredName(names)
  await ctx.database.set('mio.relational', { id: rel.id }, {
    knownNames: JSON.stringify(names),
    preferredName: preferred,
  })
}

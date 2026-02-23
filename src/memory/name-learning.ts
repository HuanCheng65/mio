import { Context } from 'koishi'
import { NameObservation } from './types'

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
 * 更新用户的已知称呼（接受结构化输入，由 extraction 调用）
 */
export async function updateKnownNames(
  ctx: Context,
  groupId: string,
  userId: string,
  name: string,
  source: 'others_call' | 'self_intro',
): Promise<void> {
  const rows = await ctx.database.get('mio.relational', { groupId, userId })
  if (rows.length === 0) return

  const rel = rows[0]
  const names: NameObservation[] = JSON.parse(rel.knownNames || '[]')

  const existing = names.find(n => n.name === name)
  const now = Date.now()

  if (existing) {
    existing.count++
    existing.lastSeen = now
    if (source === 'self_intro') existing.source = 'self_intro'
  } else {
    names.push({
      name,
      source,
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

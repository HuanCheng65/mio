import { Context } from 'koishi'
import type { MioTokenUsageRow } from '../memory/tables'

export interface ModelUsage {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  calls: number
}

export type ConversationCacheHitSource = 'explicit' | 'implicit-only' | 'none'

export interface ConversationCacheLogInput {
  personaId: string
  personaName: string
  personaHash: string
  cacheHitSource: ConversationCacheHitSource
  cachedTokens: number
  cacheName?: string
  phase?: 'main' | 'search'
}

export type PurposeUsageMap = Record<string, ModelUsage>

interface BufferedUsage extends ModelUsage {
  purposeStats: PurposeUsageMap
}

export interface TokenStats {
  totalPromptTokens: number
  totalCompletionTokens: number
  totalCachedTokens: number
  totalCalls: number
  byModel: Record<string, ModelUsage>
  byDate: Record<string, { promptTokens: number; completionTokens: number; cachedTokens: number; calls: number }>
  byPurpose: PurposeUsageMap
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function createUsage(): ModelUsage {
  return { promptTokens: 0, completionTokens: 0, cachedTokens: 0, calls: 0 }
}

function addUsage(target: ModelUsage, promptTokens: number, completionTokens: number, cachedTokens: number, calls: number = 1) {
  target.promptTokens += promptTokens
  target.completionTokens += completionTokens
  target.cachedTokens += cachedTokens
  target.calls += calls
}

export function formatConversationCacheLog(input: ConversationCacheLogInput): string {
  const parts = ['conversation-cache']

  if (input.phase) {
    parts.push(`phase=${input.phase}`)
  }

  parts.push(`persona=${input.personaId}`)
  parts.push(`personaName=${input.personaName}`)
  parts.push(`personaHash=${input.personaHash.slice(0, 8)}`)
  parts.push(`cache=${input.cacheHitSource}`)
  parts.push(`cachedTokens=${input.cachedTokens}`)

  if (input.cacheName) {
    parts.push(`cacheName=${input.cacheName}`)
  }

  return parts.join(' ')
}

function ensureUsage(map: Record<string, ModelUsage>, key: string): ModelUsage {
  if (!map[key]) {
    map[key] = createUsage()
  }
  return map[key]
}

function mergePurposeStats(
  base: PurposeUsageMap | undefined,
  delta: PurposeUsageMap | undefined,
): PurposeUsageMap {
  const merged: PurposeUsageMap = {}

  for (const [purpose, usage] of Object.entries(base || {})) {
    addUsage(ensureUsage(merged, purpose), usage.promptTokens, usage.completionTokens, usage.cachedTokens, usage.calls)
  }
  for (const [purpose, usage] of Object.entries(delta || {})) {
    addUsage(ensureUsage(merged, purpose), usage.promptTokens, usage.completionTokens, usage.cachedTokens, usage.calls)
  }

  return merged
}

function normalizePurposeStats(row: MioTokenUsageRow): PurposeUsageMap {
  const purposeStats = mergePurposeStats(row.purposeStats, undefined)
  if (Object.keys(purposeStats).length > 0) {
    return purposeStats
  }
  return {
    unknown: {
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      cachedTokens: row.cachedTokens,
      calls: row.calls,
    },
  }
}

export class TokenTracker {
  private ctx: Context | null = null
  // buffer key: "date:model"
  private buffer = new Map<string, BufferedUsage>()

  init(ctx: Context) {
    this.ctx = ctx
  }

  record(model: string, promptTokens: number, completionTokens: number, cachedTokens: number, purpose: string = 'chat') {
    const key = `${today()}:${model}`
    const existing = this.buffer.get(key)
    if (existing) {
      addUsage(existing, promptTokens, completionTokens, cachedTokens)
      addUsage(ensureUsage(existing.purposeStats, purpose), promptTokens, completionTokens, cachedTokens)
    } else {
      const usage: BufferedUsage = {
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        calls: 0,
        purposeStats: {},
      }
      addUsage(usage, promptTokens, completionTokens, cachedTokens)
      addUsage(ensureUsage(usage.purposeStats, purpose), promptTokens, completionTokens, cachedTokens)
      this.buffer.set(key, usage)
    }
  }

  async flush() {
    if (!this.ctx || this.buffer.size === 0) return

    for (const [key, usage] of this.buffer) {
      const [date, model] = splitKey(key)
      const rows = await this.ctx.database.get('mio.token_usage', { date, model })

      if (rows.length > 0) {
        await this.ctx.database.set('mio.token_usage', { id: rows[0].id }, {
          promptTokens: rows[0].promptTokens + usage.promptTokens,
          completionTokens: rows[0].completionTokens + usage.completionTokens,
          cachedTokens: rows[0].cachedTokens + usage.cachedTokens,
          calls: rows[0].calls + usage.calls,
          purposeStats: mergePurposeStats(rows[0].purposeStats, usage.purposeStats),
        })
      } else {
        await this.ctx.database.create('mio.token_usage', {
          date,
          model,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          cachedTokens: usage.cachedTokens,
          calls: usage.calls,
          purposeStats: usage.purposeStats,
        } as MioTokenUsageRow)
      }
    }

    this.buffer.clear()
  }

  async getStats(): Promise<TokenStats> {
    await this.flush()

    if (!this.ctx) {
      return {
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalCachedTokens: 0,
        totalCalls: 0,
        byModel: {},
        byDate: {},
        byPurpose: {},
      }
    }

    const rows = await this.ctx.database.get('mio.token_usage', {})

    let totalPromptTokens = 0
    let totalCompletionTokens = 0
    let totalCachedTokens = 0
    let totalCalls = 0
    const byModel: Record<string, ModelUsage> = {}
    const byDate: Record<string, { promptTokens: number; completionTokens: number; cachedTokens: number; calls: number }> = {}
    const byPurpose: PurposeUsageMap = {}

    for (const row of rows) {
      totalPromptTokens += row.promptTokens
      totalCompletionTokens += row.completionTokens
      totalCachedTokens += row.cachedTokens
      totalCalls += row.calls

      // aggregate by model
      addUsage(ensureUsage(byModel, row.model), row.promptTokens, row.completionTokens, row.cachedTokens, row.calls)

      // aggregate by date
      addUsage(ensureUsage(byDate, row.date), row.promptTokens, row.completionTokens, row.cachedTokens, row.calls)

      // aggregate by purpose
      const purposeStats = normalizePurposeStats(row)
      for (const [purpose, usage] of Object.entries(purposeStats)) {
        addUsage(ensureUsage(byPurpose, purpose), usage.promptTokens, usage.completionTokens, usage.cachedTokens, usage.calls)
      }
    }

    return { totalPromptTokens, totalCompletionTokens, totalCachedTokens, totalCalls, byModel, byDate, byPurpose }
  }

  async reset() {
    this.buffer.clear()
    if (this.ctx) {
      await this.ctx.database.remove('mio.token_usage', {})
    }
  }
}

function splitKey(key: string): [string, string] {
  // "2026-02-23:gpt-4o" -> ["2026-02-23", "gpt-4o"]
  const i = key.indexOf(':')
  return [key.slice(0, i), key.slice(i + 1)]
}

export function extendTokenTable(ctx: Context) {
  ctx.model.extend('mio.token_usage', {
    id: 'unsigned',
    date: 'string(10)',
    model: 'string(255)',
    promptTokens: { type: 'unsigned', initial: 0 },
    completionTokens: { type: 'unsigned', initial: 0 },
    cachedTokens: { type: 'unsigned', initial: 0 },
    calls: { type: 'unsigned', initial: 0 },
    purposeStats: { type: 'json', initial: {} },
  }, {
    autoInc: true,
    primary: 'id',
    unique: [['date', 'model']],
  })
}

export const tokenTracker = new TokenTracker()

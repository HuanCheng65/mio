import { Context } from 'koishi'

export interface ModelUsage {
  /** 全部输入 token，含缓存读和缓存写 */
  promptTokens: number
  completionTokens: number
  /** 缓存读（命中） */
  cachedTokens: number
  /** 缓存写：只有 Anthropic 单独计费、单独报告（1 小时 TTL 是普通输入的 2 倍价），其他供应商为 0 */
  cacheWriteTokens: number
  calls: number
}

export type PurposeUsageMap = Record<string, ModelUsage>

export interface MioTokenUsageRow {
  id: number
  date: string        // YYYY-MM-DD
  model: string
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  calls: number
  purposeStats?: PurposeUsageMap
}

declare module 'koishi' {
  interface Tables {
    'mio.token_usage': MioTokenUsageRow
  }
}

interface BufferedUsage extends ModelUsage {
  purposeStats: PurposeUsageMap
}

export interface TokenUsageDetail {
  date: string
  model: string
  purpose: string
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  calls: number
}

export interface TokenStats {
  totalPromptTokens: number
  totalCompletionTokens: number
  totalCachedTokens: number
  totalCacheWriteTokens: number
  totalCalls: number
  byModel: Record<string, ModelUsage>
  byDate: Record<string, ModelUsage>
  byPurpose: PurposeUsageMap
  detail: TokenUsageDetail[]
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function createUsage(): ModelUsage {
  return { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, calls: 0 }
}

function addUsage(target: ModelUsage, delta: ModelUsage) {
  target.promptTokens += delta.promptTokens
  target.completionTokens += delta.completionTokens
  target.cachedTokens += delta.cachedTokens
  target.cacheWriteTokens += delta.cacheWriteTokens
  target.calls += delta.calls
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
    addUsage(ensureUsage(merged, purpose), usage)
  }
  for (const [purpose, usage] of Object.entries(delta || {})) {
    addUsage(ensureUsage(merged, purpose), usage)
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
      cacheWriteTokens: row.cacheWriteTokens,
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

  record(model: string, usage: Omit<ModelUsage, 'calls'>, purpose: string = 'chat') {
    const key = `${today()}:${model}`
    let buffered = this.buffer.get(key)
    if (!buffered) {
      buffered = { ...createUsage(), purposeStats: {} }
      this.buffer.set(key, buffered)
    }
    const delta = { ...usage, calls: 1 }
    addUsage(buffered, delta)
    addUsage(ensureUsage(buffered.purposeStats, purpose), delta)
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
          cacheWriteTokens: rows[0].cacheWriteTokens + usage.cacheWriteTokens,
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
          cacheWriteTokens: usage.cacheWriteTokens,
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
        totalCacheWriteTokens: 0,
        totalCalls: 0,
        byModel: {},
        byDate: {},
        byPurpose: {},
        detail: [],
      }
    }

    const rows = await this.ctx.database.get('mio.token_usage', {})

    let totalPromptTokens = 0
    let totalCompletionTokens = 0
    let totalCachedTokens = 0
    let totalCacheWriteTokens = 0
    let totalCalls = 0
    const byModel: Record<string, ModelUsage> = {}
    const byDate: Record<string, ModelUsage> = {}
    const byPurpose: PurposeUsageMap = {}

    for (const row of rows) {
      totalPromptTokens += row.promptTokens
      totalCompletionTokens += row.completionTokens
      totalCachedTokens += row.cachedTokens
      totalCacheWriteTokens += row.cacheWriteTokens
      totalCalls += row.calls

      // aggregate by model
      addUsage(ensureUsage(byModel, row.model), row)

      // aggregate by date
      addUsage(ensureUsage(byDate, row.date), row)

      // aggregate by purpose
      const purposeStats = normalizePurposeStats(row)
      for (const [purpose, usage] of Object.entries(purposeStats)) {
        addUsage(ensureUsage(byPurpose, purpose), usage)
      }
    }

    const detail: TokenUsageDetail[] = []
    for (const row of rows) {
      const purposes = normalizePurposeStats(row)
      for (const [purpose, usage] of Object.entries(purposes)) {
        detail.push({
          date: row.date,
          model: row.model,
          purpose,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          cachedTokens: usage.cachedTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          calls: usage.calls,
        })
      }
    }

    detail.sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date)
      if (a.model !== b.model) return a.model.localeCompare(b.model)
      return a.purpose.localeCompare(b.purpose)
    })

    return { totalPromptTokens, totalCompletionTokens, totalCachedTokens, totalCacheWriteTokens, totalCalls, byModel, byDate, byPurpose, detail }
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
    cacheWriteTokens: { type: 'unsigned', initial: 0 },
    calls: { type: 'unsigned', initial: 0 },
    purposeStats: { type: 'json', initial: {} },
  }, {
    autoInc: true,
    primary: 'id',
    unique: [['date', 'model']],
  })
}

export const tokenTracker = new TokenTracker()

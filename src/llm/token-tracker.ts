import { Context } from 'koishi'
import type { MioTokenUsageRow } from '../memory/tables'

export interface ModelUsage {
  promptTokens: number
  completionTokens: number
  calls: number
}

export interface TokenStats {
  totalPromptTokens: number
  totalCompletionTokens: number
  totalCalls: number
  byModel: Record<string, ModelUsage>
  byDate: Record<string, { promptTokens: number; completionTokens: number; calls: number }>
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export class TokenTracker {
  private ctx: Context | null = null
  // buffer key: "date:model"
  private buffer = new Map<string, ModelUsage>()

  init(ctx: Context) {
    this.ctx = ctx
  }

  record(model: string, promptTokens: number, completionTokens: number) {
    const key = `${today()}:${model}`
    const existing = this.buffer.get(key)
    if (existing) {
      existing.promptTokens += promptTokens
      existing.completionTokens += completionTokens
      existing.calls++
    } else {
      this.buffer.set(key, { promptTokens, completionTokens, calls: 1 })
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
          calls: rows[0].calls + usage.calls,
        })
      } else {
        await this.ctx.database.create('mio.token_usage', {
          date,
          model,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          calls: usage.calls,
        } as MioTokenUsageRow)
      }
    }

    this.buffer.clear()
  }

  async getStats(): Promise<TokenStats> {
    await this.flush()

    if (!this.ctx) {
      return { totalPromptTokens: 0, totalCompletionTokens: 0, totalCalls: 0, byModel: {}, byDate: {} }
    }

    const rows = await this.ctx.database.get('mio.token_usage', {})

    let totalPromptTokens = 0
    let totalCompletionTokens = 0
    let totalCalls = 0
    const byModel: Record<string, ModelUsage> = {}
    const byDate: Record<string, { promptTokens: number; completionTokens: number; calls: number }> = {}

    for (const row of rows) {
      totalPromptTokens += row.promptTokens
      totalCompletionTokens += row.completionTokens
      totalCalls += row.calls

      // aggregate by model
      if (byModel[row.model]) {
        byModel[row.model].promptTokens += row.promptTokens
        byModel[row.model].completionTokens += row.completionTokens
        byModel[row.model].calls += row.calls
      } else {
        byModel[row.model] = {
          promptTokens: row.promptTokens,
          completionTokens: row.completionTokens,
          calls: row.calls,
        }
      }

      // aggregate by date
      if (byDate[row.date]) {
        byDate[row.date].promptTokens += row.promptTokens
        byDate[row.date].completionTokens += row.completionTokens
        byDate[row.date].calls += row.calls
      } else {
        byDate[row.date] = {
          promptTokens: row.promptTokens,
          completionTokens: row.completionTokens,
          calls: row.calls,
        }
      }
    }

    return { totalPromptTokens, totalCompletionTokens, totalCalls, byModel, byDate }
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
    calls: { type: 'unsigned', initial: 0 },
  }, {
    autoInc: true,
    primary: 'id',
    unique: [['date', 'model']],
  })
}

export const tokenTracker = new TokenTracker()

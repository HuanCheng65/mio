import { $, Context } from 'koishi'
import { ProviderManager, ModelConfig } from '../llm/provider'
import { tokenTracker } from '../llm/token-tracker'

export interface MioMetaRow {
  key: string
  value: string
}

declare module 'koishi' {
  interface Tables {
    'mio.meta': MioMetaRow
  }
}

export function extendMetaTable(ctx: Context) {
  ctx.model.extend('mio.meta', {
    key: 'string(63)',
    value: 'text',
  }, {
    primary: 'key',
  })
}

/**
 * 向量只有同一个模型算出来的才能互相比较。库里按 key 记录算向量用的模型名，
 * 和当前配置不一致时拒绝启用 embedding，而不是让检索悄悄失效。
 * vectorTables 是存了这个 key 对应向量的表，用来判断"有数据但没有记录"的情况。
 */
export async function verifyEmbeddingModel(
  ctx: Context,
  service: EmbeddingService,
  key: string,
  vectorTables: readonly string[],
): Promise<void> {
  const current = service.modelName
  const [row] = await ctx.database.get('mio.meta', { key })

  if (!row) {
    const counts = await Promise.all(vectorTables.map((t) => ctx.database.eval(t as any, (r: any) => $.count(r.id))))
    if (counts.some((c) => c > 0)) {
      throw new Error(
        `${vectorTables.join('、')} 里已有数据，但没有记录是用哪个 embedding 模型算的向量。` +
        `如果确认就是 ${current}，请在 mio.meta 表插入 { key: "${key}", value: "${current}" } 后重启`,
      )
    }
    await ctx.database.create('mio.meta', { key, value: current })
  } else if (row.value !== current) {
    throw new Error(
      `embedding 模型从 ${row.value} 换成了 ${current}，${vectorTables.join('、')} 里的旧向量与新模型不可比。` +
      `请改回 ${row.value}，或清空这些数据后重新开始`,
    )
  }

  service.markModelVerified()
}

/**
 * 调用方负责跳过还没有向量的记录；走到这里的两个向量必须来自同一个 embedding 模型。
 * 维度不一致说明库里混进了别的模型算的向量，比较结果没有意义，直接报错。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) {
    throw new Error(`cosineSimilarity: empty embedding (dims ${a.length} vs ${b.length})`)
  }
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: embedding dimension mismatch (${a.length} vs ${b.length})，库里的向量和当前 embedding 模型不一致`)
  }
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

export class EmbeddingService {
  private modelVerified = false

  constructor(
    private providerManager: ProviderManager,
    private modelConfig: ModelConfig,
  ) { }

  get modelName(): string {
    return this.modelConfig.modelName
  }

  /** 由 MemoryService 在确认库里的向量与当前模型一致后调用 */
  markModelVerified(): void {
    this.modelVerified = true
  }

  async embed(text: string): Promise<number[]> {
    const result = await this.embedBatch([text])
    return result[0]
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    if (!this.modelVerified) {
      throw new Error('embedding 模型一致性检查未通过（见启动日志），记忆系统不可用')
    }

    const provider = this.providerManager.getOpenAIProvider(this.modelConfig.providerId)
    if (!provider) {
      throw new Error(`Embedding provider not found: ${this.modelConfig.providerId}`)
    }

    const response = await provider.embeddings.create({
      model: this.modelConfig.modelName,
      input: texts,
    })

    tokenTracker.record(
      this.modelConfig.modelName,
      response.usage?.prompt_tokens || 0,
      0,
      0,
      'embedding',
    )

    // 按 index 排序确保顺序一致
    return response.data
      .sort((a, b) => a.index - b.index)
      .map(d => d.embedding)
  }
}

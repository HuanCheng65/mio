import { ProviderManager, ModelConfig } from '../llm/provider'

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
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
  constructor(
    private providerManager: ProviderManager,
    private modelConfig: ModelConfig,
  ) {}

  async embed(text: string): Promise<number[]> {
    const result = await this.embedBatch([text])
    return result[0]
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []

    const provider = this.providerManager.getOpenAIProvider(this.modelConfig.providerId)
    if (!provider) {
      throw new Error(`Embedding provider not found: ${this.modelConfig.providerId}`)
    }

    const response = await provider.embeddings.create({
      model: this.modelConfig.modelName,
      input: texts,
    })

    // 按 index 排序确保顺序一致
    return response.data
      .sort((a, b) => a.index - b.index)
      .map(d => d.embedding)
  }
}

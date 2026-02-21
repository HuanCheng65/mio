import { Context } from 'koishi'
import { StickerDB } from './db'
import { StickerIngestion, StickerIngestionInput } from './ingestion'
import { EmbeddingService } from '../memory/embedding'
import { VLMImageAnalysis } from './types'

export { VLMImageAnalysis } from './types'
export { StickerIngestionInput } from './ingestion'

export interface StickerConfig {
  enabled: boolean
  imageDir: string
  maxPoolSize: number
}

export class StickerService {
  private db: StickerDB
  private ingestion: StickerIngestion

  constructor(
    ctx: Context,
    private embedding: EmbeddingService,
    private config: StickerConfig,
  ) {
    this.db = new StickerDB(ctx)
    this.ingestion = new StickerIngestion(this.db, embedding, config.imageDir)
  }

  async maybeCollect(
    imageUrl: string,
    imageBuffer: Buffer,
    analysis: VLMImageAnalysis,
    sourceUser: string,
  ): Promise<void> {
    if (!this.config.enabled) return
    await this.ingestion.maybeCollect({ imageUrl, imageBuffer, analysis, sourceUser })
  }
}

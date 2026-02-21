import { Context } from 'koishi'
import { StickerDB } from './db'
import { StickerIngestion, StickerIngestionInput } from './ingestion'
import { StickerRetrieval } from './retrieval'
import { StickerMaintenance } from './maintenance'
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
  private retrieval: StickerRetrieval
  private maintenance: StickerMaintenance
  private cachedSummary = ''

  constructor(
    ctx: Context,
    private embedding: EmbeddingService,
    private config: StickerConfig,
  ) {
    this.db = new StickerDB(ctx)
    this.ingestion = new StickerIngestion(this.db, embedding, config.imageDir)
    this.retrieval = new StickerRetrieval(this.db, embedding)
    this.maintenance = new StickerMaintenance(this.db)
  }

  async runDailyMaintenance(): Promise<void> {
    if (!this.config.enabled) return
    await this.maintenance.runDaily()
    this.cachedSummary = await this.maintenance.generateSummary()
  }

  async runWeeklyDedup(): Promise<void> {
    if (!this.config.enabled) return
    await this.maintenance.runWeeklyDedup()
  }

  getSummary(): string {
    return this.cachedSummary
  }

  async resolveSticker(intent: string): Promise<string | null> {
    if (!this.config.enabled) return null
    return this.retrieval.resolveSticker(intent)
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

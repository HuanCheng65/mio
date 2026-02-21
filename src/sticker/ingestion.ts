import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { Jimp, intToRGBA } from 'jimp'
import { Logger } from 'koishi'
import { StickerDB } from './db'
import { EmbeddingService } from '../memory/embedding'
import { VLMImageAnalysis } from './types'
import { MioStickerRow } from '../memory/tables'

export const SOFT_LIMIT = 80
export const HARD_LIMIT = 120
export const MAX_STICKER_BYTES = 2 * 1024 * 1024  // 2 MB

export interface StickerIngestionInput {
  imageUrl: string
  imageBuffer: Buffer
  analysis: VLMImageAnalysis
  sourceUser: string
}

export class StickerIngestion {
  constructor(
    private db: StickerDB,
    private embedding: EmbeddingService,
    private imageDir: string,
    private logger: Logger,
  ) {
    if (!fs.existsSync(this.imageDir)) {
      fs.mkdirSync(this.imageDir, { recursive: true })
    }
  }

  async maybeCollect(input: StickerIngestionInput): Promise<void> {
    if (!input.analysis.sticker_collect) return

    // 0. 大小检查，跳过过大的图片防止内存占用过高
    if (input.imageBuffer.length > MAX_STICKER_BYTES) {
      this.logger.debug(`图片过大 (${(input.imageBuffer.length / 1024 / 1024).toFixed(1)} MB)，跳过收藏`)
      return
    }

    // 1. Perceptual hash dedup
    const phash = await computePHash(input.imageBuffer)
    this.logger.debug(`pHash 计算完成: ${phash} (来自 ${input.sourceUser})`)
    const existing = await this.db.findByPhash(phash)
    if (existing) {
      await this.db.incrementEncounterCount(existing.id)
      this.logger.debug(`重复图片，encounter_count +1: "${existing.description.slice(0, 30)}"`)
      return
    }

    // 2. Save image file
    const ext = guessExtension(input.imageUrl)
    const sha = crypto.createHash('sha256').update(input.imageBuffer).digest('hex')
    const filename = `${sha}${ext}`
    const imagePath = path.join(this.imageDir, filename)
    if (!fs.existsSync(imagePath)) {
      fs.writeFileSync(imagePath, input.imageBuffer)
    }
    this.logger.debug(`文件已保存: ${filename} (${(input.imageBuffer.length / 1024).toFixed(1)} KB)`)

    // 3. Three embeddings (batch to save API calls)
    const vibe = input.analysis.sticker_vibe ?? ''
    const scene = input.analysis.sticker_scene ?? ''
    const description = input.analysis.description
    this.logger.debug(`开始 embedding: vibe="${vibe}" scene="${scene}"`)
    const [vibeEmb, sceneEmb, contentEmb] = await this.embedding.embedBatch([
      vibe, scene, description,
    ])
    this.logger.debug(`embedding 完成 (dims: ${vibeEmb.length})`)

    // 4. Initial quality score
    const vibeTags = vibe.split(/\s+/).filter(Boolean)
    const styleTags = (input.analysis.sticker_style ?? '').split(/\s+/).filter(Boolean)
    const qualityScore = calculateInitialQuality(vibeTags, styleTags)
    this.logger.debug(`质量评分: ${qualityScore.toFixed(2)} | vibe=[${vibeTags.join(',')}] style=[${styleTags.join(',')}]`)

    // 5. Insert row
    const now = Date.now()
    const row: MioStickerRow = {
      id: crypto.randomUUID(),
      image_path: imagePath,
      phash,
      description,
      vibe_tags: vibeTags,
      style_tags: styleTags,
      scene,
      vibe_embedding: vibeEmb,
      scene_embedding: sceneEmb,
      content_embedding: contentEmb,
      source_user: input.sourceUser,
      collected_at: now,
      use_count: 0,
      last_used: null,
      encounter_count: 1,
      status: 'active',
      quality_score: qualityScore,
      created_at: now,
    }
    await this.db.insert(row)
    this.logger.debug(`新表情包已收藏: "${description.slice(0, 40)}" quality=${qualityScore.toFixed(2)}`)

    // 6. Eviction if over soft limit
    await this.runEviction()
  }

  async runEviction(): Promise<void> {
    const count = await this.db.countActiveStickers()
    if (count <= SOFT_LIMIT) return

    const active = await this.db.getActiveStickers()
    const toEvict = count - SOFT_LIMIT
    const protectThreshold = count > HARD_LIMIT ? 10 : 5

    const sorted = active
      .filter(s => s.use_count < protectThreshold)
      .map(s => ({ ...s, retention: retentionValue(s) }))
      .sort((a, b) => a.retention - b.retention)

    for (const s of sorted.slice(0, toEvict)) {
      await this.db.archiveSticker(s.id)
    }
    this.logger.debug(`淘汰 ${Math.min(sorted.length, toEvict)} 张表情包，当前活跃: ${SOFT_LIMIT} 张`)
  }
}

async function computePHash(buffer: Buffer): Promise<string> {
  const SIZE = 32
  const image = await Jimp.read(buffer)
  image.resize({ w: SIZE, h: SIZE }).greyscale()

  // Build pixel matrix
  const pixels: number[][] = []
  for (let y = 0; y < SIZE; y++) {
    pixels[y] = []
    for (let x = 0; x < SIZE; x++) {
      pixels[y][x] = intToRGBA(image.getPixelColor(x, y)).r
    }
  }

  // 2D DCT — take top-left 8x8 low-frequency block
  const DCT_SIZE = 8
  const dct: number[][] = []
  for (let u = 0; u < DCT_SIZE; u++) {
    dct[u] = []
    const cu = u === 0 ? 1 / Math.sqrt(SIZE) : Math.sqrt(2 / SIZE)
    for (let v = 0; v < DCT_SIZE; v++) {
      const cv = v === 0 ? 1 / Math.sqrt(SIZE) : Math.sqrt(2 / SIZE)
      let sum = 0
      for (let x = 0; x < SIZE; x++) {
        for (let y = 0; y < SIZE; y++) {
          sum += pixels[y][x]
            * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * SIZE))
            * Math.cos(((2 * y + 1) * v * Math.PI) / (2 * SIZE))
        }
      }
      dct[u][v] = cu * cv * sum
    }
  }

  // Flatten 8x8 block, skip DC component (0,0)
  const flat: number[] = []
  for (let u = 0; u < DCT_SIZE; u++) {
    for (let v = 0; v < DCT_SIZE; v++) {
      if (u === 0 && v === 0) continue
      flat.push(dct[u][v])
    }
  }

  // Average and threshold → 63 bits + 1 padding bit = 64 bits
  const avg = flat.reduce((a, b) => a + b, 0) / flat.length
  const bits = flat.map(v => (v > avg ? '1' : '0')).join('') + '0'

  // 64 bits → 16 hex chars
  let hex = ''
  for (let i = 0; i < 64; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  }
  return hex
}

function guessExtension(url: string): string {
  const m = url.match(/\.(jpg|jpeg|png|gif|webp)(\?|$)/i)
  return m ? `.${m[1].toLowerCase()}` : '.jpg'
}

export function calculateInitialQuality(vibeTags: string[], styleTags: string[]): number {
  let score = 0.5
  if (vibeTags.length >= 3) score += 0.1
  const preferred = ['猫猫', '可爱', '简洁', '二次元', '文艺']
  score += styleTags.filter(s => preferred.some(p => s.includes(p))).length * 0.05
  return Math.min(score, 1.0)
}

export function retentionValue(s: Pick<MioStickerRow, 'quality_score' | 'use_count' | 'collected_at' | 'encounter_count'>): number {
  const days = (Date.now() - s.collected_at) / 86400000
  const freshness = days <= 3 ? 1.0 : days <= 7 ? (7 - days) / 4 : 0
  const freq = s.use_count === 0 ? 0 : Math.min(Math.log(s.use_count + 1) / Math.log(20), 1.0)
  return s.quality_score * 0.4 + freq * 0.3 + freshness * 0.2 + (s.encounter_count > 1 ? 0.1 : 0)
}

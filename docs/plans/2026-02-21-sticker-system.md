# Sticker System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement a three-phase sticker (表情包) system that auto-collects stickers from group chat via VLM, retrieves them via three-path semantic search, and maintains quality over time.

**Architecture:** One combined VLM call per image yields both chat description and sticker metadata. Stickers are stored in Koishi DB (`mio.sticker`) with three separate embeddings (vibe/scene/content). Cosine-similarity retrieval over all three paths + multi-factor rerank resolves a free-text `intent` to an image path. Quality evolves daily via score decay and eviction runs on capacity overflow.

**Tech Stack:** TypeScript, Koishi DB (SQLite), EmbeddingService from `memory/embedding.ts`, `jimp` (perceptual dHash), Node.js `crypto.randomUUID()`, existing LLMClient + ImageProcessor + PromptManager.

---

## Orientation

Key files to keep in mind:

| File | Role |
|------|------|
| `src/memory/tables.ts` | Koishi DB table declarations — add `mio.sticker` here |
| `src/pipeline/image-processor.ts` | VLM image calls — change prompt, add `analyzeImage()` |
| `src/types/response.ts` | LLM response types — add `StickerAction` |
| `data/prompts.yaml` | All prompts — two edits: image prompt + Layer 2 sticker action |
| `src/context/prompt-builder.ts` | `PromptOptions` + `buildSystemPrompt()` — add `stickerSummary?` |
| `src/memory/index.ts` | `MemoryService` — expose `getEmbeddingService()` |
| `src/index.tsx` | Main plugin — init sticker service, handle action, inject summary |

---

## Phase A: Collection + Storage

### Task A1: Add `mio.sticker` table to tables.ts

**Files:**
- Modify: `src/memory/tables.ts`

**Step 1: Add `'mio.sticker': MioStickerRow` to the `Tables` declaration**

In the `declare module 'koishi'` block (around line 4), add after `'mio.semantic'`:

```typescript
'mio.sticker': MioStickerRow
```

**Step 2: Add the `MioStickerRow` interface after `MioSemanticRow`**

```typescript
export interface MioStickerRow {
  id: string               // UUID (primary key)
  image_path: string
  phash: string
  description: string
  vibe_tags: string[]
  style_tags: string[]
  scene: string
  vibe_embedding: number[]
  scene_embedding: number[]
  content_embedding: number[]
  source_user: string
  collected_at: number
  use_count: number
  last_used: number | null
  encounter_count: number
  status: string           // 'active' | 'archived'
  quality_score: number
  created_at: number
}
```

**Step 3: Add the `ctx.model.extend` call in `extendTables()`**

At the end of `extendTables()`, before the closing `}`:

```typescript
ctx.model.extend('mio.sticker', {
  id: 'string(36)',
  image_path: 'string(512)',
  phash: 'string(64)',
  description: 'text',
  vibe_tags: { type: 'json', initial: [] },
  style_tags: { type: 'json', initial: [] },
  scene: { type: 'text', initial: '' },
  vibe_embedding: { type: 'json', initial: [] },
  scene_embedding: { type: 'json', initial: [] },
  content_embedding: { type: 'json', initial: [] },
  source_user: { type: 'string', initial: '' },
  collected_at: 'unsigned(8)',
  use_count: { type: 'unsigned', initial: 0 },
  last_used: { type: 'unsigned', nullable: true, initial: null },
  encounter_count: { type: 'unsigned', initial: 1 },
  status: { type: 'string', initial: 'active' },
  quality_score: { type: 'float', initial: 0.5 },
  created_at: 'unsigned(8)',
}, {
  primary: 'id',
})
```

**Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 5: Commit**

```bash
git add src/memory/tables.ts
git commit -m "feat(sticker): add mio.sticker table schema"
```

---

### Task A2: Add sticker VLM prompt to prompts.yaml

**Files:**
- Modify: `data/prompts.yaml`

**Step 1: Add the new prompt key after the existing `image_understanding` key (around line 874)**

```yaml
# 表情包感知型图片理解（描述 + 收藏判断，单次 VLM call）
image_understanding_sticker: |
  看这张图，完成以下任务。

  1. 描述图片内容
  简洁口语化地说这张图是什么。
  - 如果能认出具体作品、角色、游戏、品牌，写上名字
  - 表情包/梗图：说是什么梗/模板，表达什么情绪
  - 截图：提取平台来源和关键文字内容
  - 动画/游戏画面：优先识别作品名和角色名
  - 照片：概括主体和场景
  - 不要推测发送者意图或对话语境
  - 通常不超过80字，截图类不超过150字

  2. 判断是否是表情包/梗图
  表情包特征：用于表达情绪/反应，通常有夸张的表情、动作或配文。
  正常照片、截图、内容分享不算。

  3. 如果是表情包，判断是否值得收藏
  收藏偏好：可爱系、猫猫、简洁、二次元、低调自嘲、有趣的梗
  不收藏：浮夸吵闹、社会人/油腻风、大字报、低俗、政治相关
  拿不准的偏向收藏。

  4. 如果收藏，补充索引信息
  - sticker_vibe: 3-5个情绪关键词（这张图表达什么情绪/反应）
  - sticker_style: 2-3个视觉风格词
  - sticker_scene: 一句话说明适合什么场景用（15字以内）

  输出 JSON（只输出 JSON）：

  非表情包：
  {"description": "...", "sticker": false}

  表情包但不收藏：
  {"description": "...", "sticker": true, "sticker_collect": false}

  表情包且收藏：
  {"description": "...", "sticker": true, "sticker_collect": true,
   "sticker_vibe": "关键词1 关键词2 关键词3",
   "sticker_style": "风格1 风格2",
   "sticker_scene": "场景描述"}
```

**Step 2: Commit**

```bash
git add data/prompts.yaml
git commit -m "feat(sticker): add image_understanding_sticker prompt"
```

---

### Task A3: Create `src/sticker/types.ts`

**Files:**
- Create: `src/sticker/types.ts`

**Step 1: Write the file**

```typescript
// VLM response shape for the combined image analysis prompt
export interface VLMImageAnalysis {
  description: string
  sticker: boolean
  sticker_collect?: boolean
  sticker_vibe?: string    // space-separated: "无语 无奈 累了"
  sticker_style?: string   // space-separated: "猫猫 简洁"
  sticker_scene?: string   // ≤15 chars: "对方说了离谱的话时"
}
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 3: Commit**

```bash
git add src/sticker/types.ts
git commit -m "feat(sticker): add VLMImageAnalysis type"
```

---

### Task A4: Update `ImageProcessor` — add `analyzeImage()` and `downloadBuffer()`

**Files:**
- Modify: `src/pipeline/image-processor.ts`

The goal: one combined VLM call using the new prompt. `understandImage()` becomes a thin wrapper. A new public `downloadBuffer()` method allows sticker ingestion to reuse the download.

**Step 1: Add import at the top**

```typescript
import { VLMImageAnalysis } from '../sticker/types'
```

**Step 2: Add `downloadBuffer()` public method** (after `downloadImage()`, before `loadCache()`)

```typescript
async downloadBuffer(url: string): Promise<Buffer | null> {
  try {
    return await this.downloadImage(url)
  } catch (error) {
    console.error(`[ImageProcessor] 下载图片失败: ${url}`, error)
    return null
  }
}
```

**Step 3: Add `analyzeImage()` method** (after `understandImage()`)

```typescript
async analyzeImage(imageUrl: string): Promise<VLMImageAnalysis> {
  // Cache check — cache may hold old plain-text or new JSON
  const cached = await this.getCached(imageUrl)
  if (cached) {
    try {
      const parsed = JSON.parse(cached)
      if (parsed && typeof parsed.description === 'string') {
        return parsed as VLMImageAnalysis
      }
    } catch {
      // Old plain-text cache entry — treat as non-sticker description
      return { description: cached, sticker: false }
    }
  }

  console.log(`[ImageProcessor] 调用 LLM 分析图片: ${imageUrl.substring(0, 50)}...`)

  const prompt = promptManager.getRaw('image_understanding_sticker')

  try {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: JSON.stringify([
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageUrl } },
        ]),
      },
    ]

    const response = await this.llm.chat(messages, this.modelConfig, {
      maxTokens: this.modelConfig.maxTokens || 500,
    })

    const jsonMatch = response.content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('VLM response contains no JSON')

    const analysis: VLMImageAnalysis = JSON.parse(jsonMatch[0])

    // Store JSON string in cache (reusing existing cache infrastructure)
    await this.setCached(imageUrl, JSON.stringify(analysis))

    return analysis
  } catch (error) {
    console.error('[ImageProcessor] 图片分析失败:', error)
    return { description: '一张图片', sticker: false }
  }
}
```

**Step 4: Refactor `understandImage()` to delegate to `analyzeImage()`**

Replace the body of `understandImage()` (the entire method body, keep the signature):

```typescript
async understandImage(imageUrl: string): Promise<string> {
  const analysis = await this.analyzeImage(imageUrl)
  return analysis.description
}
```

Remove the old method body (the `getCached` check, LLM call, `setCached` call that was there before).

**Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 6: Commit**

```bash
git add src/pipeline/image-processor.ts src/sticker/types.ts
git commit -m "feat(sticker): add analyzeImage() + downloadBuffer() to ImageProcessor"
```

---

### Task A5: Create `src/sticker/db.ts`

**Files:**
- Create: `src/sticker/db.ts`

**Step 1: Write the file**

```typescript
import { Context } from 'koishi'
import { MioStickerRow } from '../memory/tables'
import { cosineSimilarity } from '../memory/embedding'

export interface ScoredSticker extends MioStickerRow {
  vibe_similarity?: number
  scene_similarity?: number
  content_similarity?: number
  finalScore?: number
}

export class StickerDB {
  constructor(private ctx: Context) {}

  async insert(row: MioStickerRow): Promise<void> {
    await this.ctx.database.create('mio.sticker', row)
  }

  async findByPhash(phash: string, threshold = 8): Promise<MioStickerRow | null> {
    const all = await this.ctx.database.get('mio.sticker', {})
    for (const s of all) {
      if (hammingDistance(phash, s.phash) < threshold) return s
    }
    return null
  }

  async incrementEncounterCount(id: string): Promise<void> {
    const rows = await this.ctx.database.get('mio.sticker', { id })
    if (rows.length === 0) return
    await this.ctx.database.set('mio.sticker', { id }, {
      encounter_count: rows[0].encounter_count + 1,
    })
  }

  async getActiveStickers(): Promise<MioStickerRow[]> {
    return this.ctx.database.get('mio.sticker', { status: 'active' })
  }

  async countActiveStickers(): Promise<number> {
    const rows = await this.ctx.database.get('mio.sticker', { status: 'active' })
    return rows.length
  }

  async searchByEmbedding(
    field: 'vibe_embedding' | 'scene_embedding' | 'content_embedding',
    queryVec: number[],
    topK = 10,
  ): Promise<ScoredSticker[]> {
    const active = await this.getActiveStickers()
    const simKey = field.replace('_embedding', '_similarity') as
      'vibe_similarity' | 'scene_similarity' | 'content_similarity'

    return active
      .map(s => ({ ...s, [simKey]: cosineSimilarity(s[field], queryVec) } as ScoredSticker))
      .sort((a, b) => ((b[simKey] ?? 0) - (a[simKey] ?? 0)))
      .slice(0, topK)
  }

  async recordUse(id: string): Promise<void> {
    const rows = await this.ctx.database.get('mio.sticker', { id })
    if (rows.length === 0) return
    await this.ctx.database.set('mio.sticker', { id }, {
      use_count: rows[0].use_count + 1,
      last_used: Date.now(),
    })
  }

  async archiveSticker(id: string): Promise<void> {
    await this.ctx.database.set('mio.sticker', { id }, { status: 'archived' })
  }

  async updateQualityScore(id: string, score: number): Promise<void> {
    await this.ctx.database.set('mio.sticker', { id }, { quality_score: score })
  }
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Infinity
  let dist = 0
  for (let i = 0; i < a.length; i++) {
    const xor = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    // count set bits
    let n = xor
    while (n) { dist += n & 1; n >>= 1 }
  }
  return dist
}
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 3: Commit**

```bash
git add src/sticker/db.ts
git commit -m "feat(sticker): add StickerDB helpers + hammingDistance"
```

---

### Task A6: Create `src/sticker/ingestion.ts`

**Files:**
- Create: `src/sticker/ingestion.ts`

**Step 1: Install jimp**

```bash
npm install jimp
```

jimp v0.22+ ships its own TypeScript types so no separate `@types/jimp` needed.

**Step 2: Write the file**

```typescript
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import Jimp from 'jimp'
import { StickerDB } from './db'
import { EmbeddingService } from '../memory/embedding'
import { VLMImageAnalysis } from './types'
import { MioStickerRow } from '../memory/tables'

export const SOFT_LIMIT = 80
export const HARD_LIMIT = 120

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
  ) {
    if (!fs.existsSync(this.imageDir)) {
      fs.mkdirSync(this.imageDir, { recursive: true })
    }
  }

  async maybeCollect(input: StickerIngestionInput): Promise<void> {
    if (!input.analysis.sticker_collect) return

    // 1. Perceptual hash dedup
    const phash = await computeDHash(input.imageBuffer)
    const existing = await this.db.findByPhash(phash)
    if (existing) {
      await this.db.incrementEncounterCount(existing.id)
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

    // 3. Three embeddings (batch to save API calls)
    const vibe = input.analysis.sticker_vibe ?? ''
    const scene = input.analysis.sticker_scene ?? ''
    const description = input.analysis.description
    const [vibeEmb, sceneEmb, contentEmb] = await this.embedding.embedBatch([
      vibe, scene, description,
    ])

    // 4. Initial quality score
    const vibeTags = vibe.split(/\s+/).filter(Boolean)
    const styleTags = (input.analysis.sticker_style ?? '').split(/\s+/).filter(Boolean)
    const qualityScore = calculateInitialQuality(vibeTags, styleTags)

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
  }
}

async function computeDHash(buffer: Buffer): Promise<string> {
  const image = await Jimp.read(buffer)
  image.resize(9, 8).greyscale()
  let bits = ''
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const curr = Jimp.intToRGBA(image.getPixelColor(x, y)).r
      const next = Jimp.intToRGBA(image.getPixelColor(x + 1, y)).r
      bits += curr > next ? '1' : '0'
    }
  }
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
```

**Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors. If jimp import fails, check that `npm install jimp` completed and `node_modules/jimp` exists.

**Step 4: Commit**

```bash
git add src/sticker/ingestion.ts package.json package-lock.json
git commit -m "feat(sticker): add StickerIngestion pipeline with dHash + embed"
```

---

### Task A7: Create `src/sticker/index.ts` (StickerService facade)

**Files:**
- Create: `src/sticker/index.ts`

**Step 1: Write the file**

```typescript
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
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/sticker/index.ts
git commit -m "feat(sticker): add StickerService facade"
```

---

### Task A8: Expose `getEmbeddingService()` on MemoryService

**Files:**
- Modify: `src/memory/index.ts`

**Step 1: Add public getter**

In `MemoryService`, `embeddingService` is currently private. Add a public getter after the constructor:

```typescript
getEmbeddingService(): EmbeddingService {
  return this.embeddingService
}
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/memory/index.ts
git commit -m "feat(sticker): expose getEmbeddingService() on MemoryService"
```

---

### Task A9: Wire StickerService into `index.tsx` (collection path)

**Files:**
- Modify: `src/index.tsx`

**Step 1: Add sticker import**

Add after the existing memory/search imports:

```typescript
import { StickerService } from './sticker'
```

**Step 2: Add `sticker` to `Config` interface**

In the `Config` interface (after the `search` block, before the closing `}`):

```typescript
sticker: {
  enabled: boolean
  imageDir: string
  poolSize: number
}
```

**Step 3: Add sticker Schema**

In `Config` Schema, after the `search` schema block:

```typescript
sticker: Schema.object({
  enabled: Schema.boolean().default(true).description('启用表情包收集功能'),
  imageDir: Schema.string().default('./data/stickers').description('表情包存储目录'),
  poolSize: Schema.number().default(80).description('活跃池软上限'),
}).description('表情包系统配置'),
```

**Step 4: Initialize StickerService in `apply()`**

After the search service initialization block (around line 363), add:

```typescript
// 初始化表情包系统
let stickerService: StickerService | null = null
if (config.sticker?.enabled && memory) {
  stickerService = new StickerService(ctx, memory.getEmbeddingService(), {
    enabled: true,
    imageDir: config.sticker.imageDir,
    maxPoolSize: config.sticker.poolSize,
  })
  logger.info('表情包系统已启用')
}
```

**Step 5: Trigger sticker collection in the image processing block**

Find the image processing block in the `message` handler (around line 844). The current code calls:

```typescript
images.map(img => imageProcessor.understandImage(img.url))
```

Change the entire `imageTaskPromise` assignment to use `analyzeImage()` and fire-and-forget collection. Replace the `Promise.all(images.map(img => imageProcessor.understandImage(img.url)))` call with:

```typescript
imageTaskPromise = Promise.all(
  images.map(async (img) => {
    const analysis = await imageProcessor.analyzeImage(img.url)
    // Fire-and-forget sticker collection
    if (stickerService && analysis.sticker && analysis.sticker_collect) {
      imageProcessor.downloadBuffer(img.url).then(buf => {
        if (buf) {
          stickerService!.maybeCollect(img.url, buf, analysis, msg.sender)
            .catch(err => logger.warn('[sticker] 收集失败:', err))
        }
      }).catch(err => logger.warn('[sticker] 图片下载失败:', err))
    }
    return analysis.description
  })
).then(descriptions => {
  const description = descriptions[0] || null
  // rest of existing .then() body stays unchanged
```

**Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 7: Commit**

```bash
git add src/index.tsx
git commit -m "feat(sticker): wire Phase A — sticker collection in message handler"
```

**Phase A smoke test**: Enable sticker in config. Ask someone to send a cute anime sticker in the group. Check the bot logs for `[sticker]` messages. Query `mio.sticker` via the Koishi console or a temp log line — should see one row. Send the same sticker again — `encounter_count` should be 2.

---

## Phase B: Usage Pipeline

### Task B1: Add `StickerAction` type + update prompts

**Files:**
- Modify: `src/types/response.ts`
- Modify: `data/prompts.yaml`

**Step 1: Add `StickerAction` to response.ts**

Add after `ReactAction`:

```typescript
export interface StickerAction {
  type: 'sticker'
  intent: string   // free-text: "笑死 太惨了 幸灾乐祸"
}
```

Update the `Action` union:

```typescript
export type Action = MessageAction | ReplyAction | ReactAction | StickerAction
```

**Step 2: Add sticker action to Layer 2 in prompts.yaml**

In `chat_system_layer2_format`, find the `### 3. 发表情回应 react` section. After it, before the `---` that precedes "消息 ID 说明", add:

```yaml
  ### 4. 发表情包 `sticker`

  {"type": "sticker", "intent": "情绪/场景描述"}

  从你的表情包收藏里挑一张发出去。`intent` 用自然语言描述你想表达的情绪或这张图的内容。
  系统会自动从你的收藏里找最合适的。如果没有合适的，这条 action 会被跳过（就像翻了一圈没找到）。
  表情包偶尔用就好。大部分时候文字够了。一次回复最多一个 sticker。
```

**Step 3: Add one sticker few-shot example to Layer 4**

At the end of `chat_system_layer4_fewshot` (after 示范 21), append:

```yaml
  ---

  **示范 22：朋友出了个糗，幸灾乐祸**

  群友A: 我刚把咖啡洒键盘上了
  群友B: 笑死
  群友A: 键盘还能用但是空格粘了

  → {"thought": "哈哈哈 惨", "silent": false, "search": null, "actions": [{"type": "sticker", "intent": "笑死 太惨了 幸灾乐祸"}]}
```

**Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

**Step 5: Commit**

```bash
git add src/types/response.ts data/prompts.yaml
git commit -m "feat(sticker): add StickerAction type + sticker in prompts (Layer 2 + few-shot)"
```

---

### Task B2: Create `src/sticker/retrieval.ts`

**Files:**
- Create: `src/sticker/retrieval.ts`

**Step 1: Write the file**

```typescript
import { EmbeddingService } from '../memory/embedding'
import { StickerDB, ScoredSticker } from './db'
import { MioStickerRow } from '../memory/tables'

const W = {
  VIBE: 0.25,
  SCENE: 0.20,
  CONTENT: 0.15,
  FREQUENCY: 0.15,
  FRESHNESS: 0.10,
  QUALITY: 0.10,
  REPEAT: 0.05,
}

const RELEVANCE_THRESHOLD = 0.45

export class StickerRetrieval {
  constructor(
    private db: StickerDB,
    private embedding: EmbeddingService,
  ) {}

  async resolveSticker(intent: string): Promise<string | null> {
    const intentVec = await this.embedding.embed(intent)

    const [vibeResults, sceneResults, contentResults] = await Promise.all([
      this.db.searchByEmbedding('vibe_embedding', intentVec, 10),
      this.db.searchByEmbedding('scene_embedding', intentVec, 10),
      this.db.searchByEmbedding('content_embedding', intentVec, 10),
    ])

    // Merge: keep the highest similarity per path for each sticker
    const merged = new Map<string, ScoredSticker>()
    for (const s of [...vibeResults, ...sceneResults, ...contentResults]) {
      const prev = merged.get(s.id)
      if (!prev) {
        merged.set(s.id, { ...s })
      } else {
        merged.set(s.id, {
          ...prev,
          vibe_similarity: Math.max(prev.vibe_similarity ?? 0, s.vibe_similarity ?? 0),
          scene_similarity: Math.max(prev.scene_similarity ?? 0, s.scene_similarity ?? 0),
          content_similarity: Math.max(prev.content_similarity ?? 0, s.content_similarity ?? 0),
        })
      }
    }

    const candidates = Array.from(merged.values())
    if (candidates.length === 0) return null

    const ranked = this.rerank(candidates)
    const best = ranked[0]

    const relevance = (best.vibe_similarity ?? 0) * 0.40
                    + (best.scene_similarity ?? 0) * 0.30
                    + (best.content_similarity ?? 0) * 0.30

    if (relevance < RELEVANCE_THRESHOLD) return null

    await this.db.recordUse(best.id)
    return best.image_path
  }

  private rerank(candidates: ScoredSticker[]): ScoredSticker[] {
    const now = Date.now()
    return candidates.map(s => ({
      ...s,
      finalScore: (s.vibe_similarity ?? 0) * W.VIBE
        + (s.scene_similarity ?? 0) * W.SCENE
        + (s.content_similarity ?? 0) * W.CONTENT
        + frequencyBonus(s) * W.FREQUENCY
        + freshnessBonus(s, now) * W.FRESHNESS
        + s.quality_score * W.QUALITY
        - recentRepeatPenalty(s, now) * W.REPEAT,
    })).sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0))
  }
}

function frequencyBonus(s: MioStickerRow): number {
  if (s.use_count === 0) return 0
  return Math.min(Math.log(s.use_count + 1) / Math.log(20), 1.0)
}

function freshnessBonus(s: MioStickerRow, now: number): number {
  const days = (now - s.collected_at) / 86400000
  if (days <= 3) return 1.0
  if (days <= 7) return (7 - days) / 4
  return 0
}

function recentRepeatPenalty(s: MioStickerRow, now: number): number {
  if (!s.last_used) return 0
  const hours = (now - s.last_used) / 3600000
  if (hours < 1) return 1.0
  if (hours < 24) return (24 - hours) / 24
  return 0
}
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/sticker/retrieval.ts
git commit -m "feat(sticker): add StickerRetrieval (three-path + rerank + threshold)"
```

---

### Task B3: Add `resolveSticker()` to StickerService

**Files:**
- Modify: `src/sticker/index.ts`

**Step 1: Add retrieval field + method**

Add import: `import { StickerRetrieval } from './retrieval'`

Add field: `private retrieval: StickerRetrieval`

In constructor, add: `this.retrieval = new StickerRetrieval(this.db, embedding)`

Add method:

```typescript
async resolveSticker(intent: string): Promise<string | null> {
  if (!this.config.enabled) return null
  return this.retrieval.resolveSticker(intent)
}
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/sticker/index.ts
git commit -m "feat(sticker): expose resolveSticker on StickerService"
```

---

### Task B4: Handle sticker action in `index.tsx`

**Files:**
- Modify: `src/index.tsx`

The action loop appears in two places: `processConversation()` and `handleSearch()`. Both need the sticker case.

**Step 1: Add `path` import if not already present**

Check the imports at the top of `index.tsx`. If `import * as path from 'path'` is missing, add it.

**Step 2: Add sticker case in `processConversation` action loop**

Find the action loop in `processConversation` (around line 1320). After the `react` else-if block and before the final `else` that logs "未知 action 类型", add:

```typescript
} else if (action.type === 'sticker') {
  if (!stickerService) {
    logger.debug('[sticker] 表情包服务未启用，跳过')
    continue
  }
  try {
    const imagePath = await stickerService.resolveSticker(action.intent)
    if (!imagePath) {
      logger.debug(`[sticker] 没找到匹配的表情包 (intent: ${action.intent})`)
      continue
    }
    // Send local file via file:// URL
    const fileUrl = 'file:///' + path.resolve(imagePath).replace(/\\/g, '/')
    await session.send(h.image(fileUrl))
    hasSentMessage = true
    logger.debug(`[sticker] 发送表情包: ${path.basename(imagePath)}`)
  } catch (err) {
    logger.warn('[sticker] 发送表情包失败:', err)
  }
```

**Step 3: Add same case in `handleSearch` action loop**

The `handleSearch` function has an identical action loop (around line 1007). Add the same sticker case there, but use `hasSentMessageSearch` instead of `hasSentMessage`.

**Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 5: Commit**

```bash
git add src/index.tsx
git commit -m "feat(sticker): handle sticker action in processConversation + handleSearch (Phase B complete)"
```

**Phase B smoke test**: With a few stickers already collected (from Phase A), trigger a conversation where the LLM should generate a sticker action (e.g., someone types "我刚把咖啡洒键盘上了"). Check logs: if a sticker action was generated, you'll see either `[sticker] 发送表情包` or `[sticker] 没找到匹配的表情包`. A sticker image should appear in the chat if matched.

---

## Phase C: Maintenance + Polish

### Task C1: Create `src/sticker/maintenance.ts`

**Files:**
- Create: `src/sticker/maintenance.ts`

**Step 1: Write the file**

```typescript
import { StickerDB } from './db'
import { cosineSimilarity } from '../memory/embedding'
import { MioStickerRow } from '../memory/tables'

export class StickerMaintenance {
  constructor(private db: StickerDB) {}

  async runDaily(): Promise<void> {
    const active = await this.db.getActiveStickers()
    for (const s of active) {
      const newScore = updateQualityScore(s)
      if (Math.abs(newScore - s.quality_score) > 0.001) {
        await this.db.updateQualityScore(s.id, newScore)
      }
    }
  }

  async runWeeklyDedup(): Promise<void> {
    const active = await this.db.getActiveStickers()
    const archived = new Set<string>()

    for (let i = 0; i < active.length; i++) {
      if (archived.has(active[i].id)) continue
      for (let j = i + 1; j < active.length; j++) {
        if (archived.has(active[j].id)) continue
        const vibeSim = cosineSimilarity(
          active[i].vibe_embedding, active[j].vibe_embedding,
        )
        const styleOvlp = tagOverlap(active[i].style_tags, active[j].style_tags)
        if (vibeSim > 0.90 && styleOvlp > 0.7) {
          const loser = active[i].quality_score < active[j].quality_score
            ? active[i] : active[j]
          if (loser.use_count < 5) {
            await this.db.archiveSticker(loser.id)
            archived.add(loser.id)
          }
        }
      }
    }
  }

  async generateSummary(): Promise<string> {
    const active = await this.db.getActiveStickers()
    if (active.length === 0) return ''

    const topStyles = topN(countTags(active, 'style_tags'), 3)
    const topVibes = topN(countTags(active, 'vibe_tags'), 5)
    const recent = active
      .filter(s => Date.now() - s.collected_at < 3 * 86400000)
      .sort((a, b) => b.collected_at - a.collected_at)
      .slice(0, 2)

    const lines: string[] = [`你的表情包收藏（${active.length} 张）：`]
    if (topStyles.length > 0) lines.push(`- 风格以${topStyles.join('、')}为主`)
    if (topVibes.length > 0) lines.push(`- 常见情绪：${topVibes.join('、')}`)
    if (recent.length > 0) {
      const desc = recent.map(s => `[${s.description.slice(0, 20)}]`).join('、')
      lines.push(`- 最近新收了几张：${desc}`)
    }
    return lines.join('\n')
  }
}

function updateQualityScore(s: MioStickerRow): number {
  let score = s.quality_score
  if (s.use_count > 0) {
    const useSignal = Math.min(s.use_count / 10, 0.2)
    score = score * 0.8 + (score + useSignal) * 0.2
  }
  const lastAction = s.last_used ?? s.collected_at
  const daysSince = (Date.now() - lastAction) / 86400000
  if (daysSince > 14) score *= 0.95
  if (s.encounter_count > 3) score = Math.max(score, 0.5)
  return Math.max(score, 0.05)
}

function tagOverlap(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1
  const setA = new Set(a)
  const intersection = b.filter(t => setA.has(t)).length
  return intersection / Math.max(a.length, b.length)
}

function countTags(stickers: MioStickerRow[], field: 'style_tags' | 'vibe_tags'): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const s of stickers) {
    for (const tag of s[field]) {
      counts[tag] = (counts[tag] ?? 0) + 1
    }
  }
  return counts
}

function topN(counts: Record<string, number>, n: number): string[] {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([tag]) => tag)
}
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/sticker/maintenance.ts
git commit -m "feat(sticker): add StickerMaintenance (quality decay, weekly dedup, summary)"
```

---

### Task C2: Add maintenance + summary to StickerService

**Files:**
- Modify: `src/sticker/index.ts`

**Step 1: Add maintenance field and cached summary**

Add import: `import { StickerMaintenance } from './maintenance'`

Add fields:
```typescript
private maintenance: StickerMaintenance
private cachedSummary = ''
```

In constructor: `this.maintenance = new StickerMaintenance(this.db)`

Add methods:
```typescript
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
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/sticker/index.ts
git commit -m "feat(sticker): add maintenance + summary to StickerService"
```

---

### Task C3: Wire maintenance into `MemoryService` + weekly timer

**Files:**
- Modify: `src/memory/index.ts`
- Modify: `src/index.tsx`

**Step 1: Add optional sticker service slot to MemoryService**

In `src/memory/index.ts`, add:
- A private field: `private stickerService: any = null` (use `any` to avoid circular import; `StickerService` is in `src/sticker/` which imports from `src/memory/`)
- A setter: `setStickerService(s: any): void { this.stickerService = s }`
- In `runDistillation()`, after `await this.distillation.run()`, add:

```typescript
if (this.stickerService) {
  await this.stickerService.runDailyMaintenance()
  this.ctx.logger('mio.memory').info('表情包日维护完成')
}
```

**Step 2: Wire sticker service in `index.tsx`**

After `stickerService` is initialized, add:

```typescript
if (stickerService && memory) {
  memory.setStickerService(stickerService)
}
```

**Step 3: Add weekly dedup timer in `apply()`**

After the sticker service initialization block:

```typescript
if (stickerService) {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000
  const weeklyTimer = setInterval(async () => {
    await stickerService!.runWeeklyDedup()
    logger.info('表情包周去重完成')
  }, WEEK_MS)
  ctx.on('dispose', () => clearInterval(weeklyTimer))
}
```

**Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

**Step 5: Commit**

```bash
git add src/memory/index.ts src/index.tsx
git commit -m "feat(sticker): wire daily maintenance into distillation + weekly dedup timer"
```

---

### Task C4: Inject sticker summary into system prompt

**Files:**
- Modify: `src/context/prompt-builder.ts`
- Modify: `src/index.tsx`

**Step 1: Add `stickerSummary` to `PromptOptions`**

In `prompt-builder.ts`, add to the `PromptOptions` interface:

```typescript
stickerSummary?: string
```

**Step 2: Inject summary into the prompt**

In `buildSystemPrompt()`, after the memory context block (around line 84, after the `backgroundKnowledge` block), add before the chat history section:

```typescript
if (options.stickerSummary) {
  parts.push('\n')
  parts.push(options.stickerSummary)
}
```

**Step 3: Pass summary from `processConversation()` in index.tsx**

Find the `buildSystemPrompt()` call in `processConversation()`. Add `stickerSummary` to the options:

```typescript
const systemPrompt = promptBuilder.buildSystemPrompt({
  groupId,
  userId: session.userId,
  recentMessages: recentMessagesText,
  userProfile: memoryUserProfile,
  memories: memoryMemories,
  stickerSummary: stickerService?.getSummary() || undefined,
})
```

Do the same in `handleSearch()` where `buildSystemPrompt()` is called for the followup.

**Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 5: Final smoke test**

1. Trigger `mio/trigger-distillation` via the Koishi console — this runs `runDistillation()` which now also triggers sticker maintenance.
2. Check logs for `表情包日维护完成`.
3. Add a temp `logger.debug('sticker summary:', stickerService?.getSummary())` before the `buildSystemPrompt` call. Restart and trigger a response — summary should appear in logs.
4. Remove the temp log line.

**Step 6: Commit**

```bash
git add src/context/prompt-builder.ts src/index.tsx
git commit -m "feat(sticker): inject sticker library summary into system prompt (Phase C complete)"
```

---

## Done

All three phases complete. The system:

- **Collects** stickers automatically from every group image with one combined VLM call
- **Retrieves** via three-path semantic search + multi-factor rerank on `intent`
- **Maintains** quality via daily score decay + eviction, weekly similarity dedup
- **Informs** the main LLM with a 50–80 token library summary so it knows what to request

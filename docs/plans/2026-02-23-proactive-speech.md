# Proactive Speech System (Phase 1) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the Seed-based proactive speech framework with dry-run mode and console commands for manual testing — no auto-timers, no real message sending.

**Architecture:** External stimuli (content feeds, time, memory, silence) are gathered and sent to an LLM which decides whether Mio has an "impulse" (Seed). A Seed can then be fired through the main chat LLM to generate concrete group messages. Phase 1 is fully manual (console commands trigger each step) and dry-run (actions are logged, not executed).

**Tech Stack:** TypeScript, Koishi framework, existing LLMClient, RSSHub (RSS XML), Bangumi/VNDB/Steam APIs.

---

### Task 1: Core Types

**Files:**
- Create: `src/proactive/types.ts`

**Step 1: Write the types file**

```typescript
// src/proactive/types.ts

export interface Seed {
  id: string
  groupId: string
  impulse: string
  sourceType: SeedSourceType
  sourceContext?: string
  urgency: number
  createdAt: number
  earliestFire: number
  expiresAt: number
  requiresQuiet: boolean
  relatedContent?: {
    title: string
    url?: string
    platform?: string
  }
  relatedMemory?: string
}

export type SeedSourceType =
  | 'content_feed'
  | 'time_trigger'
  | 'memory'
  | 'silence'
  | 'emotion'

export interface ContentItem {
  source: string
  title: string
  brief: string
  url?: string
  platform: string
}

export interface ContentDigest {
  items: ContentItem[]
  polledAt: number
}

export interface TimeContext {
  hour: number
  weekday: number
  isWeekend: boolean
  period: 'late_night' | 'morning' | 'midday' | 'afternoon' | 'evening' | 'night'
}

export interface SeedGenerationResult {
  hasSeed: boolean
  seed?: Seed
  contentItemCount: number
  timeContext: string
  hasMemory: boolean
  hasSilence: boolean
  rawResponse: string
}

export interface FireResult {
  fired: boolean
  seed?: Seed
  thought?: string
  actions?: any[]
  schedulerOverview: {
    dailyCount: number
    lastProactiveTime: number
    wouldAllow: boolean
    blockedReason?: string
  }
  rawResponse?: string
}

export interface SeedPoolStatus {
  seeds: Array<{
    id: string
    groupId: string
    impulse: string
    urgency: number
    sourceType: SeedSourceType
    createdAt: number
    earliestFire: number
    expiresAt: number
    isReady: boolean
    isExpired: boolean
  }>
}
```

**Step 2: Build to verify**

Run: `cd E:/danmaku/next-danmaku-bot && yarn build`
Expected: Compiles without errors (new file has no imports from project)

**Step 3: Commit**

```bash
git add src/proactive/types.ts
git commit -m "feat(proactive): add core types for seed-based proactive speech"
```

---

### Task 2: SeedPool

**Files:**
- Create: `src/proactive/seed-pool.ts`

**Step 1: Write the SeedPool**

```typescript
// src/proactive/seed-pool.ts

import { Seed, SeedPoolStatus } from './types'

export class SeedPool {
  private seeds: Seed[] = []
  private readonly MAX_SIZE = 3

  add(seed: Seed): void {
    if (this.seeds.length >= this.MAX_SIZE) {
      // Evict lowest urgency
      this.seeds.sort((a, b) => a.urgency - b.urgency)
      this.seeds.shift()
    }
    this.seeds.push(seed)
  }

  getBestCandidate(groupId?: string): Seed | null {
    const now = Date.now()
    // Remove expired
    this.seeds = this.seeds.filter(s => now < s.expiresAt)
    // Filter by group if specified
    const candidates = groupId
      ? this.seeds.filter(s => s.groupId === groupId)
      : this.seeds
    // Filter ready (past earliest fire time)
    const ready = candidates.filter(s => now >= s.earliestFire)
    if (ready.length === 0) return null
    // Return highest urgency
    ready.sort((a, b) => b.urgency - a.urgency)
    return ready[0]
  }

  consume(seedId: string): void {
    this.seeds = this.seeds.filter(s => s.id !== seedId)
  }

  getStatus(): SeedPoolStatus {
    const now = Date.now()
    return {
      seeds: this.seeds.map(s => ({
        id: s.id,
        groupId: s.groupId,
        impulse: s.impulse,
        urgency: s.urgency,
        sourceType: s.sourceType,
        createdAt: s.createdAt,
        earliestFire: s.earliestFire,
        expiresAt: s.expiresAt,
        isReady: now >= s.earliestFire,
        isExpired: now >= s.expiresAt,
      })),
    }
  }

  clear(): void {
    this.seeds = []
  }
}
```

**Step 2: Build to verify**

Run: `cd E:/danmaku/next-danmaku-bot && yarn build`
Expected: Compiles without errors

**Step 3: Commit**

```bash
git add src/proactive/seed-pool.ts
git commit -m "feat(proactive): add SeedPool with urgency-based eviction"
```

---

### Task 3: ContentFeedManager

**Files:**
- Create: `src/proactive/content-feed.ts`

**Step 1: Write the ContentFeedManager**

```typescript
// src/proactive/content-feed.ts

import { ContentItem, ContentDigest } from './types'

// --- RSS XML parsing helpers ---

function extractTag(xml: string, tag: string): string {
  // Try CDATA first, then plain text
  const cdataMatch = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`))
  if (cdataMatch) return cdataMatch[1].trim()
  const plainMatch = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
  if (plainMatch) return plainMatch[1].trim()
  return ''
}

function parseRssItems(xml: string): Array<{ title: string; description: string; link: string }> {
  const items: Array<{ title: string; description: string; link: string }> = []
  const itemRegex = /<item>([\s\S]*?)<\/item>/g
  let match
  while ((match = itemRegex.exec(xml)) !== null) {
    items.push({
      title: extractTag(match[1], 'title'),
      description: extractTag(match[1], 'description'),
      link: extractTag(match[1], 'link'),
    })
  }
  return items
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen) + '...'
}

function dedup(items: ContentItem[]): ContentItem[] {
  const seen = new Set<string>()
  return items.filter(item => {
    const key = item.title.toLowerCase().trim()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// --- Main class ---

export class ContentFeedManager {
  constructor(
    private rsshubBaseUrl: string,
    private logger: any,
  ) {}

  async pollAll(): Promise<ContentDigest> {
    const results = await Promise.allSettled([
      this.fetchBangumiCalendar(),
      this.fetchRsshubRoute('/bilibili/ranking/1/1/3', 'bilibili_anime', 'bilibili'),
      this.fetchRsshubRoute('/bilibili/ranking/3/1/3', 'bilibili_music', 'bilibili'),
      this.fetchRsshubRoute('/bilibili/ranking/4/1/3', 'bilibili_game', 'bilibili'),
      this.fetchSteamNews(),
      this.fetchVndbNewReleases(),
    ])

    const items: ContentItem[] = []
    const sourceNames = ['bangumi', 'bilibili_anime', 'bilibili_music', 'bilibili_game', 'steam', 'vndb']
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.status === 'fulfilled') {
        items.push(...result.value)
        this.logger.debug(`[feed] ${sourceNames[i]}: ${result.value.length} 条`)
      } else {
        this.logger.warn(`[feed] ${sourceNames[i]} 拉取失败: ${result.reason?.message || result.reason}`)
      }
    }

    return { items: dedup(items), polledAt: Date.now() }
  }

  private async fetchBangumiCalendar(): Promise<ContentItem[]> {
    const response = await fetch('https://api.bgm.tv/calendar', {
      headers: { 'User-Agent': 'mio-bot/1.0 (proactive-feed)' },
    })
    if (!response.ok) throw new Error(`Bangumi API ${response.status}`)
    const data = await response.json() as any[]
    const today = new Date().getDay()
    const bangumiDay = today === 0 ? 7 : today
    const todayEntry = data.find((d: any) => d.weekday?.id === bangumiDay)
    if (!todayEntry?.items) return []
    return todayEntry.items.slice(0, 5).map((item: any) => ({
      source: 'bangumi_calendar',
      title: item.name_cn || item.name,
      brief: item.summary ? truncate(stripHtml(item.summary), 100) : '',
      url: item.url,
      platform: 'bangumi',
    }))
  }

  private async fetchRsshubRoute(route: string, feedId: string, platform: string): Promise<ContentItem[]> {
    const url = `${this.rsshubBaseUrl}${route}`
    const response = await fetch(url)
    if (!response.ok) throw new Error(`RSSHub ${route} ${response.status}`)
    const xml = await response.text()
    return parseRssItems(xml).slice(0, 5).map(item => ({
      source: feedId,
      title: item.title,
      brief: truncate(stripHtml(item.description), 100),
      url: item.link,
      platform,
    }))
  }

  private async fetchSteamNews(): Promise<ContentItem[]> {
    const response = await fetch('https://store.steampowered.com/feeds/news.xml')
    if (!response.ok) throw new Error(`Steam RSS ${response.status}`)
    const xml = await response.text()
    return parseRssItems(xml).slice(0, 5).map(item => ({
      source: 'steam_news',
      title: item.title,
      brief: truncate(stripHtml(item.description), 100),
      url: item.link,
      platform: 'steam',
    }))
  }

  private async fetchVndbNewReleases(): Promise<ContentItem[]> {
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const dateStr = oneWeekAgo.toISOString().slice(0, 10)
    const response = await fetch('https://api.vndb.org/kana/vn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filters: ['and', ['released', '>=', dateStr]],
        fields: 'title, released, rating',
        sort: 'released',
        reverse: true,
        results: 10,
      }),
    })
    if (!response.ok) throw new Error(`VNDB API ${response.status}`)
    const data = await response.json() as any
    return (data.results || []).map((vn: any) => ({
      source: 'vndb_new_releases',
      title: vn.title,
      brief: `发售日: ${vn.released}${vn.rating ? ` 评分: ${vn.rating}` : ''}`,
      url: `https://vndb.org/${vn.id}`,
      platform: 'vndb',
    }))
  }
}
```

**Step 2: Build to verify**

Run: `cd E:/danmaku/next-danmaku-bot && yarn build`
Expected: Compiles without errors

**Step 3: Commit**

```bash
git add src/proactive/content-feed.ts
git commit -m "feat(proactive): add ContentFeedManager for RSS/API content sources"
```

---

### Task 4: ProactiveScheduler

**Files:**
- Create: `src/proactive/scheduler.ts`

**Step 1: Write the scheduler**

```typescript
// src/proactive/scheduler.ts

export interface SchedulerConfig {
  maxDaily: number
  minCooldownMs: number
  urgencyThreshold: number
  quietHours: number[]
}

export interface SchedulerCheck {
  allowed: boolean
  reason?: string
}

export class ProactiveScheduler {
  private dailyCount = 0
  private lastProactiveTime = 0
  private lastDayReset = 0

  constructor(private config: SchedulerConfig) {
    this.resetIfNewDay()
  }

  /**
   * Check if firing is allowed. Does NOT mutate state (except daily reset).
   * In Phase 1 this is advisory — console commands log the result but proceed anyway.
   */
  check(urgency: number): SchedulerCheck {
    this.resetIfNewDay()

    const hour = new Date().getHours()
    if (this.config.quietHours.includes(hour)) {
      return { allowed: false, reason: `静默时段 (${hour}点)` }
    }
    if (this.dailyCount >= this.config.maxDaily) {
      return { allowed: false, reason: `已达每日上限 (${this.dailyCount}/${this.config.maxDaily})` }
    }
    if (this.lastProactiveTime > 0 && Date.now() - this.lastProactiveTime < this.config.minCooldownMs) {
      const remainMin = Math.ceil((this.config.minCooldownMs - (Date.now() - this.lastProactiveTime)) / 60000)
      return { allowed: false, reason: `冷却中 (还需 ${remainMin} 分钟)` }
    }
    if (urgency < this.config.urgencyThreshold) {
      return { allowed: false, reason: `urgency 过低 (${urgency} < ${this.config.urgencyThreshold})` }
    }
    // Probability decay: urgency=1.0 → 100%, urgency=0.5 → ~65%, urgency=0.35 → ~45%
    if (Math.random() > urgency * 1.3) {
      return { allowed: false, reason: `概率衰减跳过 (urgency=${urgency})` }
    }
    return { allowed: true }
  }

  /** Record that a proactive message was actually sent */
  recordFired(): void {
    this.dailyCount++
    this.lastProactiveTime = Date.now()
  }

  /** Called when passive path speaks — resets cooldown to prevent immediate follow-up */
  resetCooldown(): void {
    this.lastProactiveTime = Date.now()
  }

  getStatus() {
    return {
      dailyCount: this.dailyCount,
      lastProactiveTime: this.lastProactiveTime,
    }
  }

  private resetIfNewDay(): void {
    const today = new Date().setHours(0, 0, 0, 0)
    if (today > this.lastDayReset) {
      this.dailyCount = 0
      this.lastDayReset = today
    }
  }
}
```

**Step 2: Build to verify**

Run: `cd E:/danmaku/next-danmaku-bot && yarn build`
Expected: Compiles without errors

**Step 3: Commit**

```bash
git add src/proactive/scheduler.ts
git commit -m "feat(proactive): add ProactiveScheduler with multi-layer rate limiting"
```

---

### Task 5: Prompt Templates

**Files:**
- Modify: `data/prompts.yaml` (append at end)

**Step 1: Append two new prompt templates**

Add the following to the end of `data/prompts.yaml`:

```yaml
# ============================================================
# 主动发言系统 Prompt
# ============================================================

# Seed 生成指引（拼在刺激源上下文之后）
seed_generation_instruction: |
  现在的你，有没有什么想在群里说的冲动？

  注意：
  - 大部分时候什么冲动都不会有。不要硬凑。
  - 你刷手机看到的东西，不代表你要分享到群里。大部分内容看过就看过了。
  - 如果有冲动，也只是一个模糊的念头——不需要是完整的句子或明确的话题。
  - 冲动可以很微小："有点想吐槽""好无聊""突然想起上次聊的那个"。
  - 你现在手机上看到的内容，只是可能触发你的一些东西。
    你的冲动也可以跟看到的内容完全无关。

  示范：

  [周五晚上，刷手机看到了几条B站视频和一条Steam新闻]
  → { "has_seed": false }
  （大部分时候就是这样。看过了，没什么想说的。）

  [周六下午，看到了一个关注的gal发售了，群里安静了3小时]
  → { "has_seed": true, "seed": { "impulse": "这个gal终于出了 有点心动", "urgency": 0.6, "requires_quiet": false, "earliest_minutes": 5, "expiry_hours": 4 }, "related_content_index": 3, "related_memory": null }

  [深夜1点，没看到什么特别的]
  → { "has_seed": false }

  [下午，看到B站音乐区有首翻唱播放量很高，想起前天群里有人推荐了一首ED]
  → { "has_seed": true, "seed": { "impulse": "想起前天那首歌了 还在循环", "urgency": 0.4, "requires_quiet": true, "earliest_minutes": 10, "expiry_hours": 3 }, "related_content_index": null, "related_memory": "前天有人推荐了一首ED" }

  [周三上午，看到几条番剧更新，群里有人在聊天]
  → { "has_seed": false }

  [晚上，看到Steam上一个独立游戏促销]
  → { "has_seed": false }

  [周末早上，没什么特别的内容，群里安静了5小时]
  → { "has_seed": false }
  （群里安静不代表你要找话说。没话说就是没话说。）

  ---

  如果没有任何冲动：
  { "has_seed": false }

  如果有：
  {
    "has_seed": true,
    "seed": {
      "impulse": "用你自己的内心独白描述这个冲动，一句话",
      "urgency": 0到1的数字,
      "requires_quiet": true或false,
      "earliest_minutes": 0到60的数字,
      "expiry_hours": 1到8的数字
    },
    "related_content_index": null或数字,
    "related_memory": null或"简短说明跟哪段记忆有关"
  }

  一次最多一个 seed。只输出 JSON。

# 主动发言消息生成（user prompt）
proactive_user: |
  【你刚想到了一件事】

  {impulse}

  {relatedInfo}

  ---

  【下面是群里最近的消息】

  {recentMessages}

  ---

  看看群里现在的情况，你还想说吗？
  如果群里正在聊别的，或者氛围不太对，不说也完全没关系。

  用前面说明的 JSON 格式回应。search 填 null。
```

**Step 2: Verify YAML is valid**

Run: `node -e "const YAML = require('yaml'); const fs = require('fs'); YAML.parse(fs.readFileSync('E:/danmaku/next-danmaku-bot/external/mio/data/prompts.yaml', 'utf8')); console.log('OK')"`
Expected: `OK`

**Step 3: Commit**

```bash
git add data/prompts.yaml
git commit -m "feat(proactive): add seed generation and message generation prompt templates"
```

---

### Task 6: ProactiveService

**Files:**
- Create: `src/proactive/index.ts`

This is the main orchestrator that wires SeedPool, ContentFeedManager, and ProactiveScheduler together.

**Step 1: Write the service**

```typescript
// src/proactive/index.ts

import { LLMClient } from '../llm/client'
import { PromptBuilder } from '../context/prompt-builder'
import { MessageBuffer } from '../pipeline/message-buffer'
import { ContextRenderer } from '../perception/renderer'
import { MemoryService } from '../memory'
import { StickerService } from '../sticker'
import { ModelConfig } from '../llm/provider'
import { getPromptManager } from '../memory/prompt-manager'
import { SeedPool } from './seed-pool'
import { ContentFeedManager } from './content-feed'
import { ProactiveScheduler, SchedulerConfig } from './scheduler'
import {
  Seed, TimeContext, ContentItem,
  SeedGenerationResult, FireResult, SeedPoolStatus,
} from './types'

export { SeedPool } from './seed-pool'
export { ContentFeedManager } from './content-feed'
export { ProactiveScheduler } from './scheduler'
export type { SchedulerConfig } from './scheduler'
export * from './types'

// --- Config ---

export interface ProactiveConfig extends SchedulerConfig {
  enabled: boolean
  dryRun: boolean
  seedModel: ModelConfig
  rsshubBaseUrl: string
}

export interface ProactiveDeps {
  llm: LLMClient
  chatModel: ModelConfig
  promptBuilder: PromptBuilder
  buffer: MessageBuffer
  renderer: ContextRenderer
  memory: MemoryService | null
  stickerService: StickerService | null
  botName: string
  enableGroups: string[]
  getRecentMemorySummary: (groupId: string) => Promise<string>
}

// --- Time helpers ---

function getTimeContext(): TimeContext {
  const now = new Date()
  const hour = now.getHours()
  return {
    hour,
    weekday: now.getDay(),
    isWeekend: [0, 6].includes(now.getDay()),
    period:
      hour < 6 ? 'late_night' :
      hour < 9 ? 'morning' :
      hour < 12 ? 'midday' :
      hour < 17 ? 'afternoon' :
      hour < 21 ? 'evening' : 'night',
  }
}

function formatTimeContext(ctx: TimeContext): string {
  const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const periodNames: Record<string, string> = {
    late_night: '深夜', morning: '早上', midday: '中午',
    afternoon: '下午', evening: '傍晚', night: '晚上',
  }
  return `${dayNames[ctx.weekday]} ${periodNames[ctx.period]}（${ctx.hour}点）`
}

// --- Main service ---

export class ProactiveService {
  private seedPool: SeedPool
  private feedManager: ContentFeedManager
  private scheduler: ProactiveScheduler

  constructor(
    private config: ProactiveConfig,
    private deps: ProactiveDeps,
    private logger: any,
  ) {
    this.seedPool = new SeedPool()
    this.feedManager = new ContentFeedManager(config.rsshubBaseUrl, logger)
    this.scheduler = new ProactiveScheduler(config)
  }

  // === Console command: mio/seed-generate ===

  async generateSeed(groupId: string): Promise<SeedGenerationResult> {
    this.logger.info(`[proactive] seed 生成开始 (群: ${groupId})`)

    // 1. Gather stimuli
    const timeCtx = getTimeContext()
    const timeStr = formatTimeContext(timeCtx)
    this.logger.debug(`[proactive] 时间上下文: ${timeStr}`)

    // Content feeds
    let contentDigest
    try {
      contentDigest = await this.feedManager.pollAll()
      this.logger.info(`[proactive] 拉取到 ${contentDigest.items.length} 条内容`)
    } catch (err) {
      this.logger.warn('[proactive] 内容拉取整体失败:', err)
      contentDigest = { items: [] as ContentItem[], polledAt: Date.now() }
    }

    // Memory
    let memorySummary = ''
    try {
      memorySummary = await this.deps.getRecentMemorySummary(groupId)
      if (memorySummary) this.logger.debug(`[proactive] 记忆摘要:\n${memorySummary}`)
    } catch (err) {
      this.logger.warn('[proactive] 记忆摘要获取失败:', err)
    }

    // Silence
    const recentMessages = this.deps.buffer.getRecent(groupId)
    const lastMsgTime = recentMessages.length > 0
      ? recentMessages[recentMessages.length - 1].timestamp
      : 0
    const silentHours = lastMsgTime > 0
      ? Math.floor((Date.now() - lastMsgTime) / (1000 * 60 * 60))
      : 0
    const isSilent = silentHours >= 3

    // 2. Assemble prompt
    const prompt = this.assembleSeedPrompt(timeStr, contentDigest.items, memorySummary, isSilent ? silentHours : null)
    this.logger.debug(`[proactive] seed prompt 已组装 (${prompt.length} chars)`)
    this.logger.debug(`[proactive] seed prompt: ${prompt}`)

    // 3. Call LLM
    const response = await this.deps.llm.chat(
      [{ role: 'user', content: prompt }],
      this.config.seedModel,
      { responseFormat: 'json_object' },
    )
    this.logger.info(
      `[proactive] seed LLM 响应 (tokens: ${response.usage.promptTokens}+${response.usage.completionTokens}): ${response.content}`,
    )

    // 4. Parse
    let parsed: any
    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/)
      parsed = JSON.parse(jsonMatch![0])
    } catch {
      this.logger.error('[proactive] seed LLM 输出解析失败')
      return {
        hasSeed: false, contentItemCount: contentDigest.items.length,
        timeContext: timeStr, hasMemory: !!memorySummary, hasSilence: isSilent,
        rawResponse: response.content,
      }
    }

    if (!parsed.has_seed) {
      this.logger.info('[proactive] LLM 判断：没有冲动')
      return {
        hasSeed: false, contentItemCount: contentDigest.items.length,
        timeContext: timeStr, hasMemory: !!memorySummary, hasSilence: isSilent,
        rawResponse: response.content,
      }
    }

    // 5. Construct Seed
    const seedData = parsed.seed
    const now = Date.now()
    const seed: Seed = {
      id: crypto.randomUUID(),
      groupId,
      impulse: seedData.impulse,
      sourceType: this.inferSourceType(parsed),
      urgency: Math.max(0, Math.min(1, seedData.urgency)),
      createdAt: now,
      earliestFire: now + (seedData.earliest_minutes || 0) * 60 * 1000,
      expiresAt: now + (seedData.expiry_hours || 4) * 60 * 60 * 1000,
      requiresQuiet: seedData.requires_quiet ?? false,
    }

    if (parsed.related_content_index != null) {
      // related_content_index is 1-based in the prompt display
      const idx = parsed.related_content_index - 1
      const item = contentDigest.items[idx]
      if (item) {
        seed.relatedContent = { title: item.title, url: item.url, platform: item.platform }
        seed.sourceType = 'content_feed'
      }
    }

    if (parsed.related_memory) {
      seed.relatedMemory = parsed.related_memory
      if (!seed.relatedContent) seed.sourceType = 'memory'
    }

    // 6. Add to pool
    this.seedPool.add(seed)
    this.logger.info(`[proactive] seed 已入池: "${seed.impulse}" (urgency=${seed.urgency}, source=${seed.sourceType})`)

    return {
      hasSeed: true, seed,
      contentItemCount: contentDigest.items.length,
      timeContext: timeStr, hasMemory: !!memorySummary, hasSilence: isSilent,
      rawResponse: response.content,
    }
  }

  // === Console command: mio/seed-fire ===

  async fireSeed(groupId: string): Promise<FireResult> {
    const seed = this.seedPool.getBestCandidate(groupId)

    // Scheduler advisory check
    const schedulerCheck = seed
      ? this.scheduler.check(seed.urgency)
      : { allowed: false, reason: '无可用 seed' }

    const schedulerOverview = {
      dailyCount: this.scheduler.getStatus().dailyCount,
      lastProactiveTime: this.scheduler.getStatus().lastProactiveTime,
      wouldAllow: schedulerCheck.allowed,
      blockedReason: schedulerCheck.reason,
    }

    if (!seed) {
      this.logger.info('[proactive] 没有可触发的 seed')
      return { fired: false, schedulerOverview }
    }

    this.logger.info(`[proactive] 触发 seed: "${seed.impulse}" (urgency=${seed.urgency})`)
    this.logger.info(`[proactive] scheduler 判定: ${schedulerCheck.allowed ? '允许' : `阻止 (${schedulerCheck.reason})`}`)

    // Build system prompt (reuse passive path)
    const allMessages = this.deps.buffer.getRecent(groupId)
    const { text: recentMessagesText } = this.deps.renderer.render(allMessages, new Set())

    let memoryUserProfile = ''
    let memoryMemories = ''
    if (this.deps.memory) {
      try {
        const participantIds = [...new Set(allMessages.slice(-10).map(m => m.senderId))]
        const memCtx = await this.deps.memory.getMemoryContext(groupId, participantIds, [], allMessages)
        if (memCtx.userProfile) memoryUserProfile = memCtx.userProfile
        if (memCtx.memories) memoryMemories = memCtx.memories
      } catch (err) {
        this.logger.warn('[proactive] 记忆上下文获取失败:', err)
      }
    }

    const systemPrompt = this.deps.promptBuilder.buildSystemPrompt({
      groupId,
      userId: 'proactive',
      recentMessages: recentMessagesText,
      userProfile: memoryUserProfile,
      memories: memoryMemories,
      stickerSummary: this.deps.stickerService?.getSummary() || undefined,
    })

    // Build proactive user prompt
    const userPrompt = this.buildProactiveUserPrompt(seed, recentMessagesText)
    this.logger.debug(`[proactive] 消息生成 user prompt:\n${userPrompt}`)

    // Call main chat LLM
    const response = await this.deps.llm.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      this.deps.chatModel,
      { responseFormat: 'json_object' },
    )
    this.logger.info(
      `[proactive] 消息 LLM 响应 (tokens: ${response.usage.promptTokens}+${response.usage.completionTokens}): ${response.content}`,
    )

    // Parse
    let parsed: any
    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/)
      parsed = JSON.parse(jsonMatch![0])
    } catch {
      this.logger.error('[proactive] 消息 LLM 输出解析失败')
      this.seedPool.consume(seed.id)
      return { fired: false, seed, schedulerOverview, rawResponse: response.content }
    }

    const thought = parsed.thought || ''
    const actions = parsed.actions || []
    const isSilent = parsed.silent === true || actions.length === 0

    this.logger.info(`[proactive] thought: "${thought}"`)
    this.logger.info(`[proactive] silent: ${isSilent}, actions: ${actions.length}`)
    for (const action of actions) {
      this.logger.info(`[proactive]   ${JSON.stringify(action)}`)
    }

    // Consume seed regardless of outcome
    this.seedPool.consume(seed.id)

    // Dry-run: just log
    this.logger.info(`[proactive] [DRY-RUN] actions 不会执行`)

    return {
      fired: !isSilent,
      seed, thought, actions, schedulerOverview,
      rawResponse: response.content,
    }
  }

  // === Console command: mio/seed-pool ===

  getSeedPoolStatus(): SeedPoolStatus {
    return this.seedPool.getStatus()
  }

  // === Called by passive path for anti-collision ===

  onPassiveSpeech(): void {
    this.scheduler.resetCooldown()
  }

  // === Internal helpers ===

  private assembleSeedPrompt(
    timeStr: string,
    contentItems: ContentItem[],
    memorySummary: string,
    silentHours: number | null,
  ): string {
    let prompt = `你是澪。现在是 ${timeStr}。\n\n`

    if (contentItems.length > 0) {
      prompt += '你刚刷了一会儿手机，看到了这些：\n'
      prompt += contentItems
        .map((item, i) => `${i + 1}. [${item.platform}] ${item.title}${item.brief ? ' — ' + item.brief : ''}`)
        .join('\n')
      prompt += '\n\n'
    }

    if (memorySummary) {
      prompt += `最近群里发生的一些你还有印象的事：\n${memorySummary}\n\n`
    }

    if (silentHours !== null) {
      prompt += `群里已经安静了大概 ${silentHours} 个小时。\n\n`
    }

    prompt += '---\n\n'
    prompt += getPromptManager().getRaw('seed_generation_instruction')

    return prompt
  }

  private buildProactiveUserPrompt(seed: Seed, recentMessages: string): string {
    let relatedInfo = ''
    if (seed.relatedContent) {
      relatedInfo += `你是因为刚刷到了这个：${seed.relatedContent.title}\n`
    }
    if (seed.relatedMemory) {
      relatedInfo += `这让你想起了：${seed.relatedMemory}\n`
    }

    return getPromptManager().get('proactive_user', {
      impulse: seed.impulse,
      relatedInfo,
      recentMessages,
    })
  }

  private inferSourceType(parsed: any): Seed['sourceType'] {
    if (parsed.related_content_index != null) return 'content_feed'
    if (parsed.related_memory) return 'memory'
    return 'emotion'
  }
}
```

**Step 2: Build to verify**

Run: `cd E:/danmaku/next-danmaku-bot && yarn build`
Expected: Compiles without errors

**Step 3: Commit**

```bash
git add src/proactive/index.ts
git commit -m "feat(proactive): add ProactiveService orchestrator"
```

---

### Task 7: Integration into Main Plugin

**Files:**
- Modify: `src/index.tsx`

This task modifies the main plugin entry to add config, initialization, console commands, and anti-collision wiring.

**Step 1: Add import**

At the top of `src/index.tsx`, after the existing imports, add:

```typescript
import { ProactiveService, ProactiveConfig } from './proactive'
import type { SeedGenerationResult, FireResult, SeedPoolStatus } from './proactive/types'
```

**Step 2: Extend the Events declaration**

In the `declare module '@koishijs/plugin-console'` block, add these three entries:

```typescript
    'mio/seed-generate'(groupId?: string): Promise<SeedGenerationResult>
    'mio/seed-pool'(): Promise<SeedPoolStatus>
    'mio/seed-fire'(groupId?: string): Promise<FireResult>
```

**Step 3: Add proactive config to the Config interface**

Add to the `Config` interface:

```typescript
  proactive: {
    enabled: boolean
    dryRun: boolean
    seedModel: ModelConfig
    rsshubBaseUrl: string
    maxDaily: number
    minCooldownMs: number
    urgencyThreshold: number
    quietHours: number[]
  }
```

**Step 4: Add proactive config Schema**

After the `sticker` Schema block in `Config: Schema<Config>`, add:

```typescript
  proactive: Schema.object({
    enabled: Schema.boolean().default(false).description('启用主动发言系统'),
    dryRun: Schema.boolean().default(true).description('Dry-run 模式（只记日志不发消息）'),
    seedModel: Schema.object({
      providerId: Schema.string().default('deepseek').description('Seed 生成供应商 ID'),
      modelName: Schema.string().default('deepseek-chat').description('Seed 生成模型名称'),
      temperature: Schema.number().default(0.7).description('温度参数'),
      maxTokens: Schema.number().default(200).description('最大 Token 数'),
    }).description('Seed 生成模型配置'),
    rsshubBaseUrl: Schema.string().default('http://localhost:1200').description('RSSHub 实例地址'),
    maxDaily: Schema.number().default(3).description('每日主动发言上限'),
    minCooldownMs: Schema.number().default(7200000).description('两次主动发言最小间隔（毫秒）'),
    urgencyThreshold: Schema.number().default(0.35).description('最低 urgency 阈值'),
    quietHours: Schema.array(Schema.number()).default([1, 2, 3, 4, 5, 6, 7]).description('静默时段（小时）'),
  }).description('主动发言系统配置'),
```

**Step 5: Initialize ProactiveService**

Inside `apply()`, after the sticker service initialization block (around line 391) and before the extraction scheduler init, add:

```typescript
  // 初始化主动发言系统
  let proactive: ProactiveService | null = null
  if (config.proactive?.enabled) {
    if (!providerManager.hasProvider(config.proactive.seedModel.providerId)) {
      logger.warn(`Seed 模型供应商不存在: ${config.proactive.seedModel.providerId}，主动发言已禁用`)
    } else {
      const getRecentMemorySummary = async (groupId: string): Promise<string> => {
        if (!memory) return ''
        try {
          const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000
          const episodes = await ctx.database.get('mio.episodic', { archived: false })
          return episodes
            .filter(e => e.eventTime > threeDaysAgo && (e.importance ?? 0) >= 0.5)
            .sort((a, b) => b.eventTime - a.eventTime)
            .slice(0, 5)
            .map(e => `- ${e.summary}`)
            .join('\n')
        } catch (err) {
          logger.warn('[proactive] 记忆摘要查询失败:', err)
          return ''
        }
      }

      proactive = new ProactiveService(
        {
          enabled: true,
          dryRun: config.proactive.dryRun,
          seedModel: config.proactive.seedModel,
          rsshubBaseUrl: config.proactive.rsshubBaseUrl,
          maxDaily: config.proactive.maxDaily,
          minCooldownMs: config.proactive.minCooldownMs,
          urgencyThreshold: config.proactive.urgencyThreshold,
          quietHours: config.proactive.quietHours,
        },
        {
          llm,
          chatModel: config.models.chat,
          promptBuilder,
          buffer,
          renderer,
          memory,
          stickerService,
          botName: config.botName,
          enableGroups: config.enableGroups,
          getRecentMemorySummary,
        },
        logger,
      )
      logger.info(`主动发言系统已启用 (dryRun=${config.proactive.dryRun}, seed: ${config.proactive.seedModel.providerId}/${config.proactive.seedModel.modelName})`)
    }
  }
```

**Step 6: Register console commands**

Inside the `ctx.inject(['console'], (ctx) => { ... })` block, after the existing token stats listeners, add:

```typescript
    // === 主动发言调试 ===

    ctx.console.addListener('mio/seed-generate', async (groupId?: string) => {
      if (!proactive) throw new Error('主动发言系统未启用')
      const targetGroup = groupId || config.enableGroups[0]
      if (!targetGroup) throw new Error('未指定群号且无启用群')
      return proactive.generateSeed(targetGroup)
    })

    ctx.console.addListener('mio/seed-pool', async () => {
      if (!proactive) throw new Error('主动发言系统未启用')
      return proactive.getSeedPoolStatus()
    })

    ctx.console.addListener('mio/seed-fire', async (groupId?: string) => {
      if (!proactive) throw new Error('主动发言系统未启用')
      const targetGroup = groupId || config.enableGroups[0]
      if (!targetGroup) throw new Error('未指定群号且无启用群')
      return proactive.fireSeed(targetGroup)
    })
```

**Step 7: Wire anti-collision**

In `processConversation()`, find the two places where `hasSentMessage` triggers updates (around lines 1583 and 1368). After each `debouncer.markSpoke(groupId)` call, add:

```typescript
        if (proactive) proactive.onPassiveSpeech()
```

There are two locations:
1. In the main `processConversation` function (around line 1583-1586)
2. In the `handleSearch` function (around line 1366-1369)

**Step 8: Build to verify**

Run: `cd E:/danmaku/next-danmaku-bot && yarn build`
Expected: Compiles without errors

**Step 9: Commit**

```bash
git add src/index.tsx
git commit -m "feat(proactive): integrate proactive service with config, console commands, and anti-collision"
```

---

### Task 8: End-to-End Verification

**Prerequisites:**
- Bot is running with proactive.enabled = true
- RSSHub is running on configured port (optional — feeds fail gracefully)

**Step 1: Verify build**

Run: `cd E:/danmaku/next-danmaku-bot && yarn build`
Expected: Clean compilation

**Step 2: Start the bot and check initialization logs**

Expected logs:
```
主动发言系统已启用 (dryRun=true, seed: <provider>/<model>)
```

**Step 3: Test mio/seed-pool (empty state)**

In Koishi sandbox, call `mio/seed-pool`.
Expected: `{ "seeds": [] }`

**Step 4: Test mio/seed-generate**

In Koishi sandbox, call `mio/seed-generate`.
Expected:
- Logger shows content feed fetch attempts (some may fail if RSSHub is not running — that's OK)
- Logger shows the assembled prompt
- Logger shows LLM response
- Returns either `{ "hasSeed": false, ... }` or `{ "hasSeed": true, "seed": { ... }, ... }`

**Step 5: Test mio/seed-pool (after generate)**

If seed was generated, call `mio/seed-pool`.
Expected: Shows the seed with urgency, impulse, ready/expired status.

**Step 6: Test mio/seed-fire**

If seed is in pool, call `mio/seed-fire`.
Expected:
- Logger shows the system prompt + proactive user prompt being built
- Logger shows LLM response with thought and actions
- Logger shows `[DRY-RUN] actions 不会执行`
- Returns FireResult with thought, actions, and scheduler overview
- No actual messages sent to group

**Step 7: Verify anti-collision**

After the bot responds to a group message via passive path, check logs for:
```
[proactive] scheduler cooldown reset
```
(This line should appear because `onPassiveSpeech()` calls `scheduler.resetCooldown()`. Actually, there's no explicit log for this — you can verify by calling `mio/seed-fire` immediately after passive speech and checking that `schedulerOverview.lastProactiveTime` is recent.)

**Step 8: Commit all remaining changes**

```bash
git add -A
git commit -m "feat(proactive): complete Phase 1 proactive speech system with dry-run and console commands"
```

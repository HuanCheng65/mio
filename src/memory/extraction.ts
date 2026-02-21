import { LLMClient } from '../llm/client'
import { ModelConfig } from '../llm/provider'
import { ExtractionResult, ExtractionVibe } from './types'
import { NormalizedMessage } from '../perception/types'
import { ContextRenderer } from '../perception/renderer'
import { getPromptManager } from './prompt-manager'
import { Context } from 'koishi'

const promptManager = getPromptManager()
const renderer = new ContextRenderer()

// Bot 的统一 userId（用于 participants 字段）
const BOT_USER_ID = 'bot'

/**
 * Triage 结果（快通道）
 */
interface TriageResult {
  worthRemembering: boolean
  vibes: ExtractionVibe[]
}

/**
 * 快通道：判断是否值得记忆 + 提取即时情绪
 */
async function triageMessages(
  llm: LLMClient,
  modelConfig: ModelConfig,
  messages: NormalizedMessage[],
  botName: string,
): Promise<TriageResult> {
  if (messages.length === 0) {
    return { worthRemembering: false, vibes: [] }
  }

  // 格式化消息
  const formatted = messages.map(m => {
    const time = new Date(m.timestamp).toLocaleTimeString('zh-CN', {
      hour: '2-digit', minute: '2-digit',
    })
    if (m.isBot) {
      return `${BOT_USER_ID}[${botName}](${time}): ${renderer.renderContent(m)}`
    } else {
      return `${m.senderId}[${m.sender}](${time}): ${renderer.renderContent(m)}`
    }
  }).join('\n')

  const response = await llm.chat(
    [
      { role: 'system', content: promptManager.get('triage', { messages: formatted }) },
      { role: 'user', content: '请判断。' },
    ],
    modelConfig,
    { temperature: 0.3, maxTokens: 200, responseFormat: 'json_object' },
  )

  try {
    const jsonMatch = response.content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return { worthRemembering: false, vibes: [] }
    }
    const raw = JSON.parse(jsonMatch[0])

    return {
      worthRemembering: raw.worth_remembering || false,
      vibes: (raw.vibes || []).map((v: any) => ({
        userId: v.user || '',
        vibe: v.feeling || '',
        ttlHours: v.hours ?? 2,
      })),
    }
  } catch {
    return { worthRemembering: false, vibes: [] }
  }
}

/**
 * 消息分块策略（设计文档 §4.7）
 */
function chunkMessages(messages: NormalizedMessage[]): NormalizedMessage[][] {
  const chunks: NormalizedMessage[][] = []
  let currentChunk: NormalizedMessage[] = []
  let lastTimestamp = 0

  for (const msg of messages) {
    // 断点 1: 连续 5 分钟无消息
    if (lastTimestamp > 0 && msg.timestamp - lastTimestamp > 5 * 60 * 1000) {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk)
        currentChunk = []
      }
    }

    currentChunk.push(msg)
    lastTimestamp = msg.timestamp

    // 断点 2: 每块不超过 30 条消息
    if (currentChunk.length >= 30) {
      chunks.push(currentChunk)
      currentChunk = []
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk)
  }

  return chunks
}

/**
 * 判断 chunk 是否是纯灌水/刷屏（应该跳过）
 */
function isSpamChunk(chunk: NormalizedMessage[]): boolean {
  if (chunk.length < 5) return false

  // 检测 1: 超过 60% 的消息是单字符或纯表情
  const shortMessages = chunk.filter(
    (msg) => renderer.renderContent(msg).length <= 3 || /^[\u{1F300}-\u{1F9FF}]+$/u.test(renderer.renderContent(msg)),
  ).length
  if (shortMessages / chunk.length > 0.6) return true

  // 检测 2: 超过 70% 的消息是重复内容
  const contentCounts = new Map<string, number>()
  for (const msg of chunk) {
    const normalized = renderer.renderContent(msg).trim().toLowerCase()
    contentCounts.set(normalized, (contentCounts.get(normalized) || 0) + 1)
  }
  const maxRepeat = Math.max(...contentCounts.values())
  if (maxRepeat / chunk.length > 0.7) return true

  return false
}

/**
 * 判断 chunk 是否涉及澪关心的话题
 */
function hasRelevantTopics(chunk: NormalizedMessage[]): boolean {
  // 从 persona 配置中读取澪关心的话题关键词
  // 这里硬编码一些常见的，实际应该从配置读取
  const relevantKeywords = [
    'gal', 'galgame', '视觉小说', 'key', 'clannad', 'air', 'kanon',
    '音乐', '歌', 'ed', 'op', 'bgm',
    '动画', '番剧', '新番',
    '游戏', 'steam',
  ]

  const text = chunk.map((m) => renderer.renderContent(m)).join(' ').toLowerCase()

  // 至少匹配 2 个关键词，或者单个关键词出现 3+ 次
  let matchCount = 0
  for (const keyword of relevantKeywords) {
    const regex = new RegExp(keyword, 'gi')
    const matches = text.match(regex)
    if (matches) {
      matchCount += matches.length
    }
  }

  return matchCount >= 3
}

/**
 * 判断是否需要提取这个 chunk（优先级策略）
 */
function shouldExtractChunk(
  chunk: NormalizedMessage[],
  groupId: string,
): boolean {
  // 预检：纯灌水/刷屏 → 直接跳过
  if (isSpamChunk(chunk)) return false

  // 优先级 1: 澪参与的对话段 → 一定提取
  const mioActive = chunk.some((msg) => msg.isBot)
  if (mioActive) return true

  // 优先级 2: 澪被 mentioned 的对话段 → 一定提取
  const mioMentioned = chunk.some((msg) => renderer.renderContent(msg).includes('<at id="mio"/>'))
  if (mioMentioned) return true

  // 优先级 3: 涉及澪关心话题的对话段 → 提取
  if (hasRelevantTopics(chunk)) return true

  // 优先级 4: 其余对话 → 33% 概率抽样提取（相当于平均每 3 次提取 1 次）
  return Math.random() < 0.33
}

/**
 * 提取单个 chunk 的记忆（原有逻辑）
 */
async function extractChunk(
  llm: LLMClient,
  modelConfig: ModelConfig,
  messages: NormalizedMessage[],
  botName: string,
): Promise<ExtractionResult> {
  if (messages.length === 0) {
    return { worthRemembering: false, episodes: [], relationalUpdates: [], sessionVibes: [] }
  }

  // 建立 userId 集合和昵称到 userId 的映射（用于验证和 fallback）
  const validUserIds = new Set<string>()
  const nicknameToUserId = new Map<string, string>()

  // 添加 bot 的 userId
  validUserIds.add(BOT_USER_ID)

  for (const m of messages) {
    if (!m.isBot) {
      validUserIds.add(m.senderId)
      nicknameToUserId.set(m.sender, m.senderId)
    }
  }

  // 格式化消息（统一使用 userId 作为主标识，bot 使用 BOT_USER_ID）
  const formatted = messages.map(m => {
    const time = new Date(m.timestamp).toLocaleTimeString('zh-CN', {
      hour: '2-digit', minute: '2-digit',
    })
    if (m.isBot) {
      return `${BOT_USER_ID}[${botName}](${time}): ${renderer.renderContent(m)}`
    } else {
      return `${m.senderId}[${m.sender}](${time}): ${renderer.renderContent(m)}`
    }
  }).join('\n')

  const response = await llm.chat(
    [
      { role: 'system', content: promptManager.getRaw('extraction') },
      { role: 'user', content: formatted },
    ],
    modelConfig,
    { temperature: 0.3, maxTokens: 800, responseFormat: 'json_object' },
  )

  try {
    const jsonMatch = response.content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return { worthRemembering: false, episodes: [], relationalUpdates: [], sessionVibes: [] }
    }
    const raw = JSON.parse(jsonMatch[0])

    return {
      worthRemembering: true,
      episodes: (raw.memories || []).map((m: any) => {
        // 验证并修正 participants：确保都是有效的 userId
        const participants = (m.participants || []).map((p: string) => {
          const normalized = String(p).trim()

          // 直接检查是否是有效 userId
          if (validUserIds.has(normalized)) return normalized

          // 尝试作为昵称查找
          const resolved = nicknameToUserId.get(normalized)
          if (resolved) return resolved

          // 检查是否是 bot（可能 LLM 填了 botName）
          if (normalized === botName || normalized.toLowerCase() === 'bot' || normalized === 'mio' || normalized === '澪') {
            return BOT_USER_ID
          }

          // 如果 LLM 错误地加了 u 前缀（比如把 "10001" 写成了 "u10001"），去掉前缀
          if (normalized.startsWith('u') && /^u\d+$/.test(normalized)) {
            const withoutPrefix = normalized.substring(1)
            if (validUserIds.has(withoutPrefix)) return withoutPrefix
          }

          // 都不是，返回原值（后续可能需要清理）
          return normalized
        })
        return {
          summary: m.summary || '',
          tags: m.topic_tags || [],
          participants,
          emotionalValence: m.emotional_valence ?? 0,
          emotionalIntensity: m.emotional_intensity ?? 0,
          mioInvolvement: m.mio_involvement || 'observer',
          importance: m.importance ?? 0.5,
        }
      }),
      relationalUpdates: (raw.relationship_observations || [])
        .map((obs: any) => {
          let userId = obs.user || ''

          // 验证 userId 是否有效
          if (!validUserIds.has(userId)) {
            // 尝试作为昵称查找
            const resolvedUserId = nicknameToUserId.get(userId)
            if (!resolvedUserId) return null
            userId = resolvedUserId
          }

          // 从原始消息中查找对应的 displayName
          const displayName = messages.find(msg => msg.senderId === userId)?.sender || userId
          return {
            userId,
            displayName,
            event: obs.observation || '',
            emotionalTone: obs.emotion || '平淡',
            importance: obs.importance ?? 0.3,
          }
        })
        .filter((r: any) => r !== null), // 过滤掉无效的记录
      sessionVibes: [], // vibes 已在快通道处理
    }
  } catch {
    return { worthRemembering: false, episodes: [], relationalUpdates: [], sessionVibes: [] }
  }
}

/**
 * 主提取函数（带分块和快慢通道）
 */
export async function extractMemories(
  llm: LLMClient,
  modelConfig: ModelConfig,
  messages: NormalizedMessage[],
  botName: string,
  ctx?: Context,
  groupId?: string,
): Promise<ExtractionResult> {
  // 如果没有提供 ctx 或 groupId，使用原有的简单逻辑（向后兼容）
  if (!ctx || !groupId) {
    return extractChunk(llm, modelConfig, messages, botName)
  }

  const logger = ctx.logger('mio.extraction')

  // 分块
  const chunks = chunkMessages(messages)
  logger.debug(`消息分为 ${chunks.length} 个块`)

  // 合并所有 chunk 的提取结果
  const allEpisodes: any[] = []
  const allRelUpdates: any[] = []
  const allVibes: any[] = []

  for (const chunk of chunks) {
    // 判断是否需要提取
    if (!shouldExtractChunk(chunk, groupId)) {
      logger.debug(`跳过非优先 chunk (${chunk.length} 条消息)`)
      continue
    }

    // 快通道：判断是否值得记忆 + 提取即时情绪
    const triage = await triageMessages(llm, modelConfig, chunk, botName)

    // vibes 立即收集（无论是否 worth_remembering）
    if (triage.vibes.length > 0) {
      allVibes.push(...triage.vibes)
    }

    // 慢通道：仅 worth_remembering 时提取详细记忆
    if (triage.worthRemembering) {
      const result = await extractChunk(llm, modelConfig, chunk, botName)
      if (result.worthRemembering) {
        allEpisodes.push(...result.episodes)
        allRelUpdates.push(...result.relationalUpdates)
      }
    } else {
      logger.debug(`快通道判断不值得记忆，跳过慢通道提取`)
    }
  }

  // 返回合并后的结果
  return {
    worthRemembering: allEpisodes.length > 0,
    episodes: allEpisodes,
    relationalUpdates: allRelUpdates,
    sessionVibes: allVibes,
  }
}

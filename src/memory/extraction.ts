import { LLMClient } from '../llm/client'
import { ModelConfig } from '../llm/provider'
import { ExtractionResult, ExtractionVibe, ExtractionNameObservation } from './types'
import { NormalizedMessage } from '../perception/types'
import { ContextRenderer } from '../perception/renderer'
import { getPromptManager } from './prompt-manager'
import { Context } from 'koishi'

const promptManager = getPromptManager()
const renderer = new ContextRenderer()

// Bot 的统一 userId（用于 participants 字段）
const BOT_USER_ID = 'bot'

/**
 * 消息分块策略
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
 * 提取单个 chunk 的记忆 + 即时情绪（单次 LLM 调用）
 */
async function extractChunk(
  llm: LLMClient,
  modelConfig: ModelConfig,
  messages: NormalizedMessage[],
  botName: string,
  logger?: ReturnType<Context['logger']>,
): Promise<ExtractionResult> {
  if (messages.length === 0) {
    return { worthRemembering: false, episodes: [], relationalUpdates: [], sessionVibes: [], nameObservations: [] }
  }

  // 建立 userId 集合和昵称到 userId 的映射（用于验证和 fallback）
  const validUserIds = new Set<string>()
  const nicknameToUserId = new Map<string, string>()
  validUserIds.add(BOT_USER_ID)

  for (const m of messages) {
    if (!m.isBot) {
      validUserIds.add(m.senderId)
      nicknameToUserId.set(m.sender, m.senderId)
    }
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

  logger?.debug(`提取 chunk: ${messages.length} 条消息, ${validUserIds.size - 1} 个用户`)

  let response
  try {
    response = await llm.chat(
      [
        { role: 'system', content: promptManager.getRaw('extraction') },
        { role: 'user', content: formatted },
      ],
      modelConfig,
      { temperature: 0.3, maxTokens: 800, responseFormat: 'json_object' },
    )
  } catch (err) {
    logger?.warn('提取 LLM 调用失败:', err)
    return { worthRemembering: false, episodes: [], relationalUpdates: [], sessionVibes: [], nameObservations: [] }
  }

  try {
    const jsonMatch = response.content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      logger?.warn('提取 LLM 返回无 JSON:', response.content.slice(0, 200))
      return { worthRemembering: false, episodes: [], relationalUpdates: [], sessionVibes: [], nameObservations: [] }
    }
    const raw = JSON.parse(jsonMatch[0])
    logger?.debug(`提取 LLM 返回: ${(raw.memories || []).length} memories, ${(raw.relationship_observations || []).length} rel, ${(raw.vibes || []).length} vibes`)

    // 解析 vibes
    const sessionVibes: ExtractionVibe[] = (raw.vibes || []).map((v: any) => ({
      userId: v.user || '',
      vibe: v.feeling || '',
      ttlHours: v.hours ?? 2,
    }))

    const episodes = (raw.memories || []).map((m: any) => {
      const participants = (m.participants || []).map((p: string) => {
        const normalized = String(p).trim()
        if (validUserIds.has(normalized)) return normalized
        const resolved = nicknameToUserId.get(normalized)
        if (resolved) return resolved
        if (normalized === botName || normalized.toLowerCase() === 'bot' || normalized === 'mio' || normalized === '澪') {
          return BOT_USER_ID
        }
        if (normalized.startsWith('u') && /^u\d+$/.test(normalized)) {
          const withoutPrefix = normalized.substring(1)
          if (validUserIds.has(withoutPrefix)) return withoutPrefix
        }
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
    })

    const relationalUpdates = (raw.relationship_observations || [])
      .map((obs: any) => {
        let userId = obs.user || ''
        if (!validUserIds.has(userId)) {
          const resolvedUserId = nicknameToUserId.get(userId)
          if (!resolvedUserId) return null
          userId = resolvedUserId
        }
        const displayName = messages.find(msg => msg.senderId === userId)?.sender || userId
        return {
          userId,
          displayName,
          event: obs.observation || '',
          emotionalTone: obs.emotion || '平淡',
          importance: obs.importance ?? 0.3,
        }
      })
      .filter((r: any) => r !== null)

    // 解析 name_observations
    const nameObservations: ExtractionNameObservation[] = (raw.name_observations || [])
      .map((obs: any) => {
        let userId = obs.user || ''
        if (!validUserIds.has(userId)) {
          const resolved = nicknameToUserId.get(userId)
          if (!resolved) return null
          userId = resolved
        }
        const source = obs.source === 'self_intro' ? 'self_intro' as const : 'others_call' as const
        const name = obs.name?.trim()
        if (!name) return null
        return { userId, name, source }
      })
      .filter((o: any) => o !== null)

    const worthRemembering = episodes.length > 0 || relationalUpdates.length > 0
    return { worthRemembering, episodes, relationalUpdates, sessionVibes, nameObservations }
  } catch (err) {
    logger?.warn('提取结果解析失败:', err, '| raw:', response.content.slice(0, 300))
    return { worthRemembering: false, episodes: [], relationalUpdates: [], sessionVibes: [], nameObservations: [] }
  }
}

/**
 * 主提取函数（分块 + 单次 LLM 调用提取）
 */
export async function extractMemories(
  llm: LLMClient,
  modelConfig: ModelConfig,
  messages: NormalizedMessage[],
  botName: string,
  ctx?: Context,
  groupId?: string,
): Promise<ExtractionResult> {
  const logger = ctx?.logger('mio.extraction')

  if (!ctx || !groupId) {
    return extractChunk(llm, modelConfig, messages, botName, logger)
  }

  const chunks = chunkMessages(messages)
  logger!.debug(`消息分为 ${chunks.length} 个块 (共 ${messages.length} 条)`)

  const allEpisodes: any[] = []
  const allRelUpdates: any[] = []
  const allVibes: any[] = []
  const allNameObs: any[] = []

  for (const chunk of chunks) {
    const result = await extractChunk(llm, modelConfig, chunk, botName, logger)

    if (result.sessionVibes.length > 0) {
      allVibes.push(...result.sessionVibes)
    }
    if (result.nameObservations.length > 0) {
      allNameObs.push(...result.nameObservations)
    }
    if (result.worthRemembering) {
      allEpisodes.push(...result.episodes)
      allRelUpdates.push(...result.relationalUpdates)
      logger!.debug(
        `chunk 提取: ${result.episodes.length} 条记忆, ` +
        `${result.relationalUpdates.length} 条关系, ` +
        `${result.sessionVibes.length} 条情绪`,
      )
    } else {
      logger!.debug(`chunk (${chunk.length} 条消息) 无值得记忆的内容`)
    }
  }

  return {
    worthRemembering: allEpisodes.length > 0,
    episodes: allEpisodes,
    relationalUpdates: allRelUpdates,
    sessionVibes: allVibes,
    nameObservations: allNameObs,
  }
}

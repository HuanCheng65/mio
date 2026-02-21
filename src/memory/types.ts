import { ModelConfig } from '../llm/provider'

// ===== Episodic Memory =====

export interface EpisodicMemory {
  id: string
  groupId: string
  summary: string                // 第一人称视角
  participants: string[]         // user_id 列表
  tags: string[]                 // 话题标签（辅助粗筛）
  embedding: number[]            // 向量
  importance: number             // 0~1.0
  emotionalValence: number       // -1.0~1.0
  emotionalIntensity: number     // 0~1.0
  mioInvolvement: 'active' | 'observer' | 'mentioned'
  accessCount: number
  lastAccessed: number
  eventTime: number
  archived: boolean
  createdAt: number
}

// ===== Relational Memory =====

export type ClosenessTier = 'close' | 'familiar' | 'acquaintance' | 'stranger'

export interface SignificantEvent {
  timestamp: number
  description: string
  emotionalTone: string
  importance: number
  sourceEpisodeId: string
  consumed: boolean
}

export interface RelationalMemory {
  groupId: string
  userId: string
  displayName: string
  coreImpression: string
  coreImpressionUpdatedAt: number
  recentImpression: string
  recentImpressionUpdatedAt: number
  closenessTier: ClosenessTier
  interactionCount: number
  recentInteractionCount: number
  lastInteraction: number
  significantEvents: SignificantEvent[]
  knownNames: NameObservation[]
  preferredName: string | null
  createdAt: number
  updatedAt: number
}

// ===== Name Learning =====

export interface NameObservation {
  name: string
  source: 'others_call' | 'self_intro' | 'nickname'
  count: number
  firstSeen: number
  lastSeen: number
}

// ===== Semantic Fact (Phase 3b) =====

export interface SemanticFact {
  id: string
  groupId: string
  subject: string  // userId 或 "group"（用于 inside_joke）
  factType: 'preference' | 'trait' | 'experience' | 'opinion' | 'status' | 'inside_joke' | 'preferred_name'
  content: string
  confidence: number
  sourceEpisodes: string[]
  firstObserved: number
  lastConfirmed: number
  supersededBy: string | null
}

// ===== Distillation Results =====

export interface DistillationResult {
  newFacts: { subject: string; factType: string; content: string; confidence: number }[]
  confirmedFacts: { id: number; newConfidence: number }[]
  evolvedFacts: { oldFactId: number; newContent: string; newConfidence: number }[]
  decayedFacts: { id: number; newConfidence: number }[]
}

export interface ImpressionResult {
  recentImpression: string   // 0-60字，可为空
}

export interface CoreImpressionResult {
  unchanged: boolean
  newImpression?: string     // 1-80字
}

// ===== Session Vibe (仅内存) =====

export interface SessionVibe {
  userId: string
  vibe: string
  expiresAt: number              // timestamp
}

// ===== Extraction Result =====

export interface ExtractionEpisode {
  summary: string
  tags: string[]
  participants: string[]
  emotionalValence: number
  emotionalIntensity: number
  mioInvolvement: 'active' | 'observer' | 'mentioned'
  importance: number
}

export interface ExtractionRelUpdate {
  userId: string
  displayName: string
  event: string
  emotionalTone: string
  importance: number
}

export interface ExtractionVibe {
  userId: string
  vibe: string
  ttlHours: number
}

export interface ExtractionResult {
  worthRemembering: boolean
  episodes: ExtractionEpisode[]
  relationalUpdates: ExtractionRelUpdate[]
  sessionVibes: ExtractionVibe[]
}

// ===== Memory Context (给 PromptBuilder) =====

export interface MemoryContext {
  userProfile: string            // 参与者印象文本
  memories: string               // 召回的记忆文本
}

// ===== Memory Config =====

export interface MemoryConfig {
  enabled: boolean
  embedding: ModelConfig          // { providerId, modelName }
  extraction: ModelConfig         // 提取用的便宜模型
  distillation: ModelConfig       // 蒸馏用模型（可复用 extraction 的便宜模型）
  distillationHour: number        // 每日蒸馏时间（默认 3，即凌晨 3 点）
  flushIntervalMs: number         // 默认 5 分钟
  maxPendingWrites: number        // 默认 20
  activePoolLimit: number         // 默认 200
}

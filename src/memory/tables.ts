import { Context } from 'koishi'

declare module 'koishi' {
  interface Tables {
    'mio.episodic': MioEpisodicRow
    'mio.relational': MioRelationalRow
    'mio.semantic': MioSemanticRow
    'mio.sticker': MioStickerRow
    'mio.token_usage': MioTokenUsageRow
  }
}

export interface MioEpisodicRow {
  id: number
  groupId: string
  summary: string
  participants: string[]
  tags: string[]
  embedding: number[]
  importance: number
  emotionalValence: number
  emotionalIntensity: number
  mioInvolvement: string
  eventTime: number
  archived: boolean
  createdAt: number
}

export interface MioRelationalRow {
  id: number
  groupId: string
  userId: string
  displayName: string
  coreImpression: string
  coreImpressionUpdatedAt: number
  recentImpression: string
  recentImpressionUpdatedAt: number
  closenessTier: string
  interactionCount: number
  lastInteraction: number
  knownNames: string  // JSON: NameObservation[]
  preferredName: string | null
  createdAt: number
  updatedAt: number
}

export interface MioSemanticRow {
  id: number
  groupId: string
  subject: string           // userId 或 "group"
  factType: string          // preference | trait | experience | opinion | status | inside_joke | preferred_name
  content: string           // 第一人称叙事
  embedding: number[]       // 语义向量（用于去重）
  confidence: number        // 0~1.0
  sourceEpisodes: number[]  // episodic memory IDs
  firstObserved: number
  lastConfirmed: number
  supersededBy: number | null  // 被哪条新 fact 取代
  createdAt: number
}

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

export interface MioTokenUsageRow {
  id: number
  date: string        // YYYY-MM-DD
  model: string
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  calls: number
}

export function extendTables(ctx: Context) {
  ctx.model.extend('mio.episodic', {
    id: 'unsigned',
    groupId: 'string(63)',
    summary: 'text',
    participants: { type: 'json', initial: [] },
    tags: { type: 'json', initial: [] },
    embedding: { type: 'json', initial: [] },
    importance: { type: 'float', initial: 0.5 },
    emotionalValence: { type: 'float', initial: 0 },
    emotionalIntensity: { type: 'float', initial: 0 },
    mioInvolvement: { type: 'string', initial: 'observer' },
    eventTime: 'unsigned(8)',
    archived: { type: 'boolean', initial: false },
    createdAt: 'unsigned(8)',
  }, {
    autoInc: true,
    primary: 'id',
  })

  ctx.model.extend('mio.relational', {
    id: 'unsigned',
    groupId: 'string(63)',
    userId: 'string(63)',
    displayName: 'string(255)',
    coreImpression: { type: 'text', initial: '' },
    coreImpressionUpdatedAt: 'unsigned(8)',
    recentImpression: { type: 'text', initial: '' },
    recentImpressionUpdatedAt: 'unsigned(8)',
    closenessTier: { type: 'string', initial: 'stranger' },
    interactionCount: { type: 'unsigned', initial: 0 },
    lastInteraction: 'unsigned(8)',
    knownNames: { type: 'text', initial: '[]' },
    preferredName: { type: 'string', nullable: true, initial: null },
    createdAt: 'unsigned(8)',
    updatedAt: 'unsigned(8)',
  }, {
    autoInc: true,
    primary: 'id',
    unique: [['groupId', 'userId']],
  })

  // Semantic facts
  ctx.model.extend('mio.semantic', {
    id: 'unsigned',
    groupId: 'string(63)',
    subject: 'string(255)',
    factType: { type: 'string', initial: 'trait' },
    content: { type: 'text', initial: '' },
    embedding: { type: 'json', initial: [] },
    confidence: { type: 'float', initial: 0.5 },
    sourceEpisodes: { type: 'json', initial: [] },
    firstObserved: 'unsigned(8)',
    lastConfirmed: 'unsigned(8)',
    supersededBy: { type: 'unsigned', nullable: true, initial: null },
    createdAt: 'unsigned(8)',
  }, {
    autoInc: true,
    primary: 'id',
  })

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
}

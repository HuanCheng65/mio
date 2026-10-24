# 澪（Mio）记忆系统设计文档

> **Version**: 5.0 — 2026-02-24
> **Status**: Current Implementation

---

## 0. 第一性原理：为什么需要记忆？

在设计任何系统之前，先问一个问题：**一个真正的群友的"记忆"是什么样的？**

一个在群里待了半年的真人群友，脑子里大概有这些东西：

1. **对每个人的印象** — "A 是 gal 狂热者，B 经常深夜 emo，C 说话很毒但人不坏"
2. **共同经历** — "上个月我们一起讨论了 CLANNAD，当时争得很激烈"
3. **群文化** — "群里流行用'草'表示笑，群里经常开 XX 的玩笑"
4. **碎片化的事实** — "A 好像是计算机专业的"、"B 昨天说在准备考研"
5. **模糊的情感色彩** — "跟 A 聊 gal 很开心"、"C 上次怼我有点不爽"
6. **当下的情绪余韵** — "刚才被 C 阴阳了一句，现在还有点不爽"

注意几个关键特征：
- **大部分记忆是模糊的**，不是精确的数据库查询
- **记忆是有偏的**，记住的是自己在意的东西
- **记忆会衰减**，但更准确地说——新的强烈体验会"挤掉"旧的平庸记忆
- **记忆不会被主动"调用"**，而是在相关话题出现时自然浮现
- **情绪有惯性**，不会因为话题切换就瞬间清零

**设计目标不是"完美记住一切"，而是"像一个真人那样不完美地记住重要的事"。**

---

## 1. 核心设计问题

### 1.1 写入问题：什么值得记住？

不是所有消息都值得记忆。一天的群聊可能有 500 条消息，但一个真人能记住的可能只有 5-10 件事。

**记忆价值评估维度：**

| 维度 | 说明 | 例子 |
|------|------|------|
| **人物关联** | 揭示了某人的特征/偏好/经历 | "A: 我今天面试挂了" |
| **情感强度** | 引发了强烈情感反应的内容 | 一场激烈的作品讨论 |
| **与澪的关联** | 直接涉及澪或澪关心的领域 | 有人推荐了一首很好的歌 |
| **群文化** | 群内的新梗、新表达、群规变化 | 一个新的群内 inside joke 的诞生 |
| **重复性** | 多次出现的模式比单次事件更值得记 | "B 每次都深夜发 emo 发言" |

**不值得记忆的：**
- 纯寒暄（"早""晚安""吃了吗"）
- 纯接梗/刷屏
- 与任何人/话题都无关联的闲聊片段
- 澪没有参与也没有关注点的对话

### 1.2 读取问题：什么时候需要回忆？

大部分对话不需要任何历史记忆。但在以下场景中，记忆至关重要：

| 场景 | 需要的记忆类型 | 例子 |
|------|---------------|------|
| **话题延续** | 近期的相关讨论 | "上次你说的那个 gal 怎么样了？" |
| **人物相关** | 对某人的了解 | A 提到考研 → 想起 A 之前说过在准备 |
| **情感一致性** | 对某事/某人的态度 | 之前说过喜欢的作品不能突然忘了 |
| **群文化运用** | 群内梗/表达 | 自然地使用群里的 inside joke |
| **被直接问到** | 任何被引用的过去 | "你之前说的那首歌是什么" |
| **情绪连续性** | 刚才的情绪余韵 | 刚跟 A 争论完不会马上跟 A 有说有笑 |

### 1.3 一致性问题：记忆如何影响人格？

记忆系统不仅是信息存储，它直接塑造了角色的可信度。如果澪：
- 上周说"我最喜欢的 KEY 作品是 CLANNAD"，这周说"AIR 是我最喜欢的"→ 人设崩塌
- 跟 A 聊得很开心，下次见到 A 却完全没有熟悉感 → 关系断裂
- 群里的经典梗完全不知道 → 像新人而不是老成员
- 刚被 A 阴阳了，转头对 A 热情如旧 → 情绪不真实

---

## 2. 记忆架构

### 2.1 总体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                      运行时层 (Runtime)                           │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              Working Memory (工作记忆缓冲)                  │  │
│  │  → 内存中的短时记忆（未写入 DB 的 episodic 暂存）            │  │
│  │  → Session Vibes（短期情绪，仅内存）                        │  │
│  │  → 读取时合并：持久记忆 + pending 记忆                      │  │
│  │  → 空闲时 / 积满时批量写入持久层                             │  │
│  └───────────────────────────────────────────────────────────┘  │
│                          │                                      │
│                   flush (批量写入)                                │
│                          ▼                                      │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              Layer 3: 动态上下文（注入 LLM prompt）          │  │
│  │                                                           │  │
│  │  ┌──────────┐  ┌───────────┐  ┌───────────────────────┐  │  │
│  │  │ 当前对话  │  │ 召回的     │  │ 参与者的关系印象       │  │  │
│  │  │ 消息缓冲  │  │ 记忆片段   │  │ + 短期情绪缓冲        │  │  │
│  │  └──────────┘  └───────────┘  └───────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────┘  │
└───────────────────────┬─────────────────────────────────────────┘
                        │ 检索 / 注入
┌───────────────────────┴─────────────────────────────────────────┐
│                    持久存储层 (SQLite via Koishi ORM)              │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              Episodic Memory (情节记忆)                    │   │
│  │  → 具体事件 + 时间 + 参与者 + 情感标签 + embedding         │   │
│  │  → 容量驱逐：21 天过期 + 池容量上限淘汰                    │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              Semantic Memory (语义记忆)                    │   │
│  │  → 第一人称视角的事实 + 群文化（subject="group"）           │   │
│  │  → 矛盾用时间线叙事处理，不用布尔标记                      │   │
│  │  → 含 embedding 用于去重                                  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              Relational Memory (关系记忆)                  │   │
│  │  → 核心印象（稳定）+ 近期印象（易变）                       │   │
│  │  → 称呼学习（preferred_name + known_names）                │   │
│  │  → 短期情绪缓冲（Session Vibe，仅内存中）                  │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 为什么是三种持久记忆？

> v5 变更：Cultural Memory 不再是独立模块。群文化类知识（inside_joke、group_expression、reaction_pattern、tool_knowledge）统一由 Semantic Memory 承载（`subject="group"`）。

一个群友记住的信息，按抽象层次可以分为：

1. **具体发生了什么** → Episodic（最具体，衰减最快）
2. **从中提炼出什么** → Semantic（抽象化后相对稳定，含个人事实和群文化）
3. **跟每个人的关系** → Relational（需要持续追踪）

信息流动方向：
```
Episodic → (多次累积) → Semantic（个人事实）
Episodic → (情感反应) → Relational
Episodic → (群体共识) → Semantic（subject="group"，群文化）
```

去掉任何一种都会有明显缺陷：
- 没有 Episodic → 无法引用具体事件
- 没有 Semantic → 每次都要从头推断人物特征，群梗无处安放
- 没有 Relational → 对所有人态度一样

### 2.3 为什么不需要独立的 Cultural Memory？

v4 设计中 Cultural Memory 有四个 type，但在实践中证明可被现有架构覆盖：

| 原 Cultural Type | 实际已被覆盖 |
|------|------------|
| `group_dynamic` "A和B总是互怼" | Relational Memory 的 core_impression |
| `topic_pattern` "每周五聊gal" | Context window（发生时自然在窗口里） |
| `expression` "草" | Context window（活跃时自然在窗口里） |
| `inside_joke` 群内典故 | Semantic Memory（subject="group"） |

根本原因：per-conversation extraction 没有足够信息判断"这是不是群文化"——文化 by definition 需要跨对话积累。但 extraction 仍然会输出 `cultural_observations`，这些观察会直写 Semantic Memory 作为 group facts，由蒸馏阶段跨对话确认和提升 confidence。

---

## 3. Working Memory（工作记忆缓冲层）

### 3.1 问题

当群聊处于高峰期：
- 记忆提取不断产出新记忆，需要写入 SQLite
- 同时新消息不断到来，主流程需要读取 SQLite 检索相关记忆
- 高频直接写入会造成数据库压力

### 3.2 解决方案：内存级工作记忆

所有 episodic 记忆提取的结果先暂存在内存中，而不是直接写数据库。

```typescript
interface PendingEpisodic {
  groupId: string
  summary: string
  participants: string[]
  tags: string[]
  embedding: number[]
  importance: number
  emotionalValence: number
  emotionalIntensity: number
  mioInvolvement: 'active' | 'observer' | 'mentioned'
  eventTime: number
}

class WorkingMemory {
  // 内存中的短时缓冲
  private pendingEpisodic: PendingEpisodic[] = []

  // session vibes 始终在内存中（短命的情绪状态）
  private sessionVibes: Map<string, SessionVibe> = new Map()

  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private config: MemoryConfig

  /**
   * 接收提取结果：生成 embedding → 去重 → 写入内存缓冲
   */
  async ingest(groupId: string, result: ExtractionResult): Promise<void> {
    if (!result.worthRemembering) return

    // 为每条 episode 生成 embedding
    const embeddings = await embeddingService.embedBatch(
      result.episodes.map(e => e.summary)
    )

    for (let i = 0; i < result.episodes.length; i++) {
      const newEmbedding = embeddings[i]

      // 去重 1: 与 pending 缓冲中的记忆比较（cosine > 0.9 = 重复）
      const isDuplicateInPending = this.pendingEpisodic.some(existing =>
        existing.groupId === groupId &&
        cosineSimilarity(newEmbedding, existing.embedding) > 0.9
      )
      if (isDuplicateInPending) continue

      // 去重 2: 与数据库中该群的活跃记忆比较
      const isDuplicateInDb = recentDbEpisodes.some(existing =>
        existing.embedding?.length > 0 &&
        cosineSimilarity(newEmbedding, existing.embedding) > 0.9
      )
      if (isDuplicateInDb) continue

      this.pendingEpisodic.push({ groupId, ...episode, embedding: newEmbedding })
    }

    // Session vibes 直接生效（key = groupId:userId）
    for (const vibe of result.sessionVibes) {
      this.sessionVibes.set(`${groupId}:${vibe.userId}`, {
        userId: vibe.userId,
        vibe: vibe.vibe,
        expiresAt: Date.now() + vibe.ttlHours * 3600_000,
      })
    }

    this.resetFlushTimer()

    // 积累过多时立即 flush
    if (this.pendingEpisodic.length >= this.config.maxPendingWrites) {
      await this.flush()
    }
  }

  /**
   * 主流程检索时调用：从 pending 缓冲中筛选
   */
  getPendingEpisodic(groupId: string): PendingEpisodic[] {
    return this.pendingEpisodic.filter(e => e.groupId === groupId)
  }

  /**
   * 获取 session vibe（自动检查过期）
   */
  getSessionVibe(groupId: string, userId: string): SessionVibe | null {
    const key = `${groupId}:${userId}`
    const vibe = this.sessionVibes.get(key)
    if (!vibe || Date.now() > vibe.expiresAt) {
      this.sessionVibes.delete(key)
      return null
    }
    return vibe
  }

  /**
   * 批量写入 SQLite
   */
  async flush(): Promise<void> {
    for (const ep of this.pendingEpisodic) {
      await db.create('mio.episodic', { ...ep, archived: false, createdAt: Date.now() })
    }
    this.pendingEpisodic = []
  }
}
```

### 3.3 关键设计

**Session Vibes 始终在内存中**：它们生命周期只有 1-8 小时，没必要写入 SQLite。进程重启时丢失也无所谓——一个真人重启（比如打了个盹醒来），短期情绪也确实会消散。

**Episodic 双重去重**：每条新记忆在写入 pending 缓冲前，都会与 (1) 已有 pending 记忆 和 (2) 数据库中该群的活跃记忆进行 embedding 余弦相似度比较。阈值 0.9 以上视为重复，跳过。

**flush 时机**：
- 定时器到期：无新写入 `flushIntervalMs`（默认 5 分钟）后自动 flush
- 积满：`pendingEpisodic` 达到 `maxPendingWrites`（默认 20 条）时立即 flush
- 进程优雅退出时：`dispose()` 中强制 flush

**读取合并**：主流程 episodic 检索时，同时查持久层和 Working Memory 中的 pending 记忆，合并后统一评分排序。这样即使还没 flush，最新的记忆也不会丢。

**容灾**：进程崩溃时未 flush 的数据会丢失。这是可接受的——丢失最近几分钟的提取结果而已。

**直写通道**：以下数据类型不经过 Working Memory，由各自的学习模块直接写入 SQLite：
- `name_observations` → `name-learning.ts` 直写 `mio.relational`
- `cultural_observations` → `culture-learning.ts` 直写 `mio.semantic`（subject="group"）
- `relationship_observations` → `person-learning.ts` 直写 `mio.semantic` + `mio.relational`

---

## 4. Episodic Memory（情节记忆）

### 4.1 数据结构

```typescript
interface EpisodicMemory {
  id: number                         // 自增主键
  groupId: string                    // 群 ID
  summary: string                    // 第一人称视角的叙事
  participants: string[]             // 参与者 userId 列表
  tags: string[]                     // 话题标签（辅助粗筛）
  embedding: number[]                // API embedding 向量（JSON 存储）
  importance: number                 // 0~1.0
  emotionalValence: number           // -1.0~1.0（消极~积极）
  emotionalIntensity: number         // 0~1.0（淡~强）
  mioInvolvement: 'active' | 'observer' | 'mentioned'
  eventTime: number                  // 事件发生时间
  archived: boolean                  // 是否已归档
  createdAt: number                  // 记录创建时间
}
```

### 4.2 写入机制

**触发时机：** 由 `MemoryExtractionScheduler` 决定何时触发提取（详见第 7 节）。

**Pipeline：**

```
当前对话消息
    │
    ├─→ [消息分块] (见 4.6)
    │
    ▼
[记忆提取 LLM Call] ──→ 结构化提取结果
    │
    ├─→ episodes[] → [Embedding API Call] → Working Memory（双重去重后写入）
    ├─→ relationship_observations[] → person-learning 直写 DB
    ├─→ name_observations[] → name-learning 直写 DB
    ├─→ cultural_observations[] → culture-learning 直写 DB
    └─→ vibes[] → Working Memory（即时生效）
```

**记忆提取 Prompt 的关键要点：**

提取 prompt 指示 LLM 以澪的视角判断对话中有什么值得记住的事。输出包含 6 个字段：

```json
{
  "memories": [
    {
      "summary": "脑子里闪过的念头，不是分析报告",
      "topic_tags": ["话题标签"],
      "participants": ["userId"],
      "emotional_valence": -1.0到1.0,
      "emotional_intensity": 0到1.0,
      "mio_involvement": "active|observer|mentioned",
      "importance": 0到1.0
    }
  ],
  "relationship_observations": [
    {
      "user": "userId",
      "observation": "对某人产生的新认识",
      "emotion": "情感语气",
      "importance": 0到1.0
    }
  ],
  "vibes": [
    {"user": "userId", "feeling": "即时情绪", "hours": 1到8}
  ],
  "name_observations": [
    {"user": "userId", "name": "称呼", "source": "self_intro|others_call"}
  ],
  "cultural_observations": [
    {"type": "expression|reaction_pattern|tool_knowledge|meme", "content": "描述", "confidence": 0.3到0.7}
  ]
}
```

**LLM 调用参数**：
- Temperature: 0.3
- Max tokens: 800
- Response format: JSON object
- 模型：配置的 `extraction` 模型（建议用便宜模型，如 DeepSeek）

**关键提取规则**：
- summary 写得像脑子里闪过的念头，不是读后感或分析报告
- **记录发生了什么，不要下结论** — 记忆应该是叙事性的
- **记事语气中性轻松** — 在回忆，不是在记仇
- participants 必须填 userId（方括号前面那个），不是昵称
- 方括号里的昵称可能是假的或恶搞的，不从昵称推导身份
- 没有值得记的就返回空数组，不要硬找

### 4.3 读取机制：混合检索

**混合检索策略（取 top-5）：**

```
当前对话消息（最近 5 条拼接）
    │
    ▼
[生成查询 embedding]
    │
    ▼
[评分所有候选记忆]
    │
    ├─→ 来源 A: DB 中所有非 archived 的 episodic 记忆
    ├─→ 来源 B: Working Memory 中的 pending 记忆
    │
    ▼
[按 score 排序 → 取 top-5]
```

**Relevance Score 公式：**

```
score = similarity × 0.5       // embedding 余弦相似度（0~1）
      + timeDecay  × 0.2       // 时间衰减
      + importance × 0.1       // 原始重要性
      + tagBoost   × 0.2       // tag 关键词命中加成
```

其中：
- `timeDecay = 0.5^(daysSince / 7)` — 7 天半衰期
- `tagBoost = 0.15` 如果记忆的任何 tag 出现在查询文本中，否则 0

**时间窗口过滤**：如果聊天记录 buffer 中最早消息的时间戳为 T，则 `eventTime >= T` 的记忆不注入（因为这些事件已经在聊天记录中可见了）。

### 4.4 Embedding 方案

**使用 API Embedding：**

```typescript
class EmbeddingService {
  constructor(
    private providerManager: ProviderManager,
    private modelConfig: ModelConfig,  // { providerId, modelName }
  ) {}

  async embed(text: string): Promise<number[]> {
    return (await this.embedBatch([text]))[0]
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const provider = this.providerManager.getOpenAIProvider(this.modelConfig.providerId)
    const response = await provider.embeddings.create({
      model: this.modelConfig.modelName,
      input: texts,
    })
    return response.data.sort((a, b) => a.index - b.index).map(d => d.embedding)
  }
}
```

**默认配置**：OpenAI `text-embedding-3-small`（1536 维），可通过 config 切换到其他 OpenAI-compatible provider。

**为什么用 API？**
- 免去本地模型的部署和维护
- 记忆提取本身就是异步的，多一次 API call 不影响用户体验
- 单条 embedding 的 API 成本极低
- 后续如果切换本地模型，只需改 embedding 的 providerId 和 modelName

**存储**：embedding 以 JSON array 存储在 SQLite 中。数据量小（几百条活跃记忆），暴力余弦相似度完全够用。

### 4.5 记忆驱逐

**双重机制：时间过期 + 容量驱逐。**

#### 机制一：时间过期

```
eventTime < 21 天前 → archived = true
```

简单直接：超过 21 天的 episodic 记忆自动归档。

#### 机制二：容量驱逐

活跃池设有软上限 `activePoolLimit`（默认 200）。

```typescript
// 蒸馏清理阶段：
if (activeCount > activePoolLimit) {
  const toEvict = activeCount - activePoolLimit
  // 按 eventTime 升序排列，淘汰最早的
  const sorted = activeEpisodic
    .filter(ep => ep.eventTime >= twentyOneDaysAgo)  // 只看还未被时间过期的
    .sort((a, b) => a.eventTime - b.eventTime)
  for (const mem of sorted.slice(0, toEvict)) {
    mem.archived = true
  }
}
```

**触发时机**：每日蒸馏清理阶段（Step 4）。

**关键设计**：
- 是**软上限**，短暂超出是允许的
- 淘汰的是 `archived`，不是删除；极端情况下仍在数据库中
- 当前实现按时间排序淘汰最早的记忆

### 4.6 记忆提取的分块策略

**问题**：群高峰期一次提取可能包含数十条消息，直接全塞给 LLM 会 context 太长且噪音多。

**分块规则：**

```typescript
function chunkMessages(messages: NormalizedMessage[]): NormalizedMessage[][] {
  // 断点 1: 连续 5 分钟无消息 = 话题断点
  // 断点 2: 每块不超过 30 条消息
  // 每个 chunk 独立提取，结果聚合
}
```

每个 chunk 独立进行一次 LLM 调用，所有 chunk 的提取结果聚合后统一返回。

### 4.7 旁观者记忆的标注

当 `mioInvolvement = 'observer'` 时，这条记忆在注入 prompt 时特殊标注：

```
（以下是你在群里看到但没参与的——你知道发生过，但别人不知道你看过）
- 前天好像看到有人在群里聊了一下今年新番的评价。
```

---

## 5. Semantic Memory（语义记忆）

### 5.1 数据结构

```typescript
interface SemanticFact {
  id: number                         // 自增主键
  groupId: string
  subject: string                    // userId 或 "group"
  factType: string                   // 见 5.5 的 factType 列表
  content: string                    // 第一人称叙事性事实
  embedding: number[]                // 语义向量（用于去重）
  confidence: number                 // 0~1.0
  sourceEpisodes: number[]           // 来源的 episodic memory IDs
  firstObserved: number
  lastConfirmed: number
  supersededBy: number | null        // 被哪条新 fact 取代（null = 活跃）
  createdAt: number
}
```

### 5.2 第一人称叙事事实

**核心原则：人脑子里的"事实"从来不是客观事实，而是"我认为的事实"。**

所有 Semantic Fact 必须从澪的主观视角书写：

```
❌ 客观数据库式：
  "A 在准备考研"
  "A 是 KEY 的铁粉"

✅ 第一人称主观式：
  "A 好像提过他最近在准备考研，感觉挺忙的"
  "A 应该算是 KEY 的铁粉吧，每次聊起来都很激动"
  "A 以前好像经常玩柚子社的，但最近感觉他在往剧情作那边靠"
```

**好处**：
- 注入 prompt 时极其自然，不需要额外润色
- 自带不确定性和情感色彩
- LLM 使用时会自然保持模糊，不会过度自信

### 5.3 写入路径

Semantic Facts 有两条写入路径：

#### 路径 A：提取时直写（实时）

`person-learning.ts` 和 `culture-learning.ts` 在每次 extraction 后直接将 `relationship_observations` 和 `cultural_observations` 写入 `mio.semantic` 表。

**去重机制**：为每条观察生成 embedding，与已有 active facts 比较，cosine >= 0.85 视为重复 → 只 bump confidence（+0.1，cap 0.8）而不创建新条目。

**人物观察的 confidence 映射**（从 importance 转换）：
- importance >= 0.7 → confidence 0.6
- importance >= 0.4 → confidence 0.5
- else → confidence 0.4

**文化观察的初始 confidence**：直接使用 extraction LLM 输出的 confidence（范围 0.3-0.7）。

#### 路径 B：蒸馏生成（每日）

蒸馏流程（Step 1）从累积的 episodic memories 中提炼出新的 semantic facts，或维护已有 facts。详见第 9 节。

### 5.4 矛盾处理：时间线叙事

**用"时间线叙事"替代"布尔值矛盾标记"。**

当蒸馏 LLM 发现新信息与旧 fact 矛盾时：
1. 将旧 fact 的 `supersededBy` 设为新 fact 的 id
2. 生成一条新的、包含时间演进的 fact

```
旧 fact: "A 应该算是柚子社的粉丝吧"  [supersededBy = 42]
                ↓
新 fact (id=42): "A 以前好像经常玩柚子社的，但最近几次聊天感觉
                  他开始觉得剧情太白开水了，在往剧情作那边靠"
                  [supersededBy = null, confidence: 0.7]
```

**好处**：
- 不需要维护矛盾状态机
- 注入 prompt 时直接就是一条自然的叙事
- LLM 能自然理解"人的偏好会演变"
- 避免了布尔标记带来的逻辑震荡

### 5.5 factType 汇总

| Type | subject | 说明 | 来源 |
|------|---------|------|------|
| `preference` | userId | 喜好偏好 | 蒸馏 |
| `trait` | userId | 性格/身份特征 | 提取直写 + 蒸馏 |
| `experience` | userId | 经历/事件 | 蒸馏 |
| `opinion` | userId | 观点/看法 | 蒸馏 |
| `status` | userId | 当前状态 | 蒸馏 |
| `inside_joke` | `"group"` | 群内梗/典故 | 蒸馏 + 文化直写 |
| `group_expression` | `"group"` | 群特有表达 | 文化直写 |
| `reaction_pattern` | `"group"` | 群反应模式 | 文化直写 |
| `tool_knowledge` | `"group"` | Bot/工具用法 | 文化直写 |

**注**：`preferred_name` 类型的 fact 不存入 semantic 表，由 `name-learning.ts` 直接维护在 `mio.relational` 表的 `knownNames`/`preferredName` 字段中。

---

## 6. Relational Memory（关系记忆）

### 6.1 设计哲学

人对另一个人的印象分为三个时间尺度：

1. **核心印象**（月级）：刻在脑子里的基底认知。"老聊友"、"话不多但有品味"——除非发生重大事件，否则不变。
2. **近期浮动**（周级）：最近几次交互的感受。"虽然一直觉得他不错，但昨天那个玩笑确实有点过分"——会随时间消退。
3. **当下情绪余韵**（小时级）：刚才这轮对话的情绪。"刚被他阴阳了一句"——持续 1-8 小时后自然消退。

### 6.2 数据结构

```typescript
interface RelationalMemory {
  // 主键
  id: number
  groupId: string                   // 群级隔离
  userId: string                    // groupId + userId 联合唯一

  displayName: string               // 最新的群昵称

  // === 核心印象（月级，极少更新）===
  coreImpression: string            // ≤80 字。"老聊友了，聊 gal 和音乐都很合得来。"
  coreImpressionUpdatedAt: number

  // === 近期印象（周级，每日蒸馏可重写）===
  recentImpression: string          // ≤60 字。"前天他推荐了一首歌我很喜欢。"
  recentImpressionUpdatedAt: number

  // === 称呼学习 ===
  knownNames: string                // JSON: NameObservation[]
  preferredName: string | null      // 最佳称呼，由 resolvePreferredName() 计算

  // === 后端分类标签（不注入 prompt）===
  closenessTier: ClosenessTier      // 'close' | 'familiar' | 'acquaintance' | 'stranger'

  // === 交互统计（后端用）===
  interactionCount: number          // 总互动次数（递增）
  lastInteraction: number           // 最后互动时间

  createdAt: number
  updatedAt: number
}

// Session Vibe 仅存在于 WorkingMemory 中
interface SessionVibe {
  userId: string
  vibe: string                      // "刚才有点不爽，他那个玩笑确实不太好笑"
  expiresAt: number                 // 过期时间戳
}
```

### 6.3 三层印象的生命周期

```
时间轴 ──────────────────────────────────────────────────→

session_vibe:     [写入] ── TTL 后自动过期 ────→ null
                  │         (1-8小时，LLM建议)
                  │
                  │ （不自动升级，但情绪如果足够强会
                  │   通过 relationship_observations
                  │   写入 semantic facts）
                  ▼
recent_impression: [每日蒸馏时从该用户近 7 天 active facts 重生成]
                  │
                  │ 如果积累了足够多的 semantic facts（>= 3）
                  │ 且超过 30 天未更新
                  ▼
core_impression:  [仅在触发条件满足时更新] ── 平时不动
```

### 6.4 短期情绪缓冲（Session Vibe）

**解决"情绪反射弧的隔夜时滞"问题。**

下午 2 点 A 惹恼了澪，下午 2:10 话题变了。如果没有 session_vibe，澪的 impression 还是昨天蒸馏的"老聊友很合得来"，会像失忆一样跟 A 有说有笑。

**session_vibe 在每次记忆提取时直接写入 Working Memory：**

```json
{
  "vibes": [
    {
      "user": "10008",
      "feeling": "说我推荐的gal偏老 有点不爽",
      "hours": 2
    }
  ]
}
```

**TTL 由提取 LLM 建议**，而非固定值：
- 轻微不爽 → 1-2 小时
- 开心的讨论 → 2-3 小时
- 严重冲突 → 6-8 小时
- 无明显情绪 → 不写入

**在 prompt 中用括号标注临时性：**

```
- 10003 （大家叫他阿K）: 老聊友了。聊 gal 和音乐都很合得来。
  前天他推荐了一首歌很对味（说我推荐的gal偏老 有点不爽）
```

括号暗示"这是一个会消退的情绪"，LLM 会据此调整语气但不会过度反应。

### 6.5 核心印象的更新

core_impression **不参与每日蒸馏的全量重写**，只在满足触发条件时更新。

```typescript
// 触发条件（全部满足）：
const activeFacts = getActiveFacts(userId)     // 该用户的 active semantic facts
const isNewUser = !rel.coreImpression          // 核心印象为空
const coreAge = daysSince(rel.coreImpressionUpdatedAt)

if (activeFacts.length < 3) return             // 至少需要 3 条 facts
if (!isNewUser && coreAge <= 30) return        // 非新用户且不超过 30 天 → 不更新
```

**更新时的 LLM 调用**：

输入是该用户 top-15 active semantic facts（按 confidence 降序），让 LLM 判断"这个人在我心里的定位变了吗"。如果没变，返回 `{"unchanged": true}`；如果变了，输出新的核心印象（≤80 字）。

### 6.6 近期印象的蒸馏

`recent_impression` 每日蒸馏时**从该用户近 7 天的 active semantic facts 重新生成**。

**输入**：该用户近 7 天的 active semantic facts + 当前的 core_impression。
**输出**：0-1 句话（≤60 字），补充 core_impression 还没覆盖到的新情况。如果没有，返回空字符串。

**关键**：不读旧的 recent_impression，每次都从源头 facts 重新生成，防止"传话筒效应"。

### 6.7 称呼学习

真人群友学习怎么叫一个人，靠的是听别人叫或对方自我介绍。

```typescript
interface NameObservation {
  name: string
  source: 'others_call' | 'self_intro'
  count: number
  firstSeen: number
  lastSeen: number
}

function resolvePreferredName(observations: NameObservation[]): string | null {
  // self_intro 优先级最高
  const selfIntro = observations.find(o => o.source === 'self_intro')
  if (selfIntro) return selfIntro.name

  // 否则取 others_call 中 count >= 2 的最高
  const byOthers = observations
    .filter(o => o.source === 'others_call')
    .sort((a, b) => b.count - a.count)
  if (byOthers.length && byOthers[0].count >= 2) return byOthers[0].name

  // 还没有足够信号，不强行取名
  return null
}
```

**称呼信号来源**：extraction 的 `name_observations` 字段。每次提取完成后，`name-learning.ts` 直接更新 `mio.relational` 表的 `knownNames` 和 `preferredName` 字段。

**提取 prompt 中的称呼规则**：
- 有人自我介绍（"叫我XX"）→ `source: "self_intro"`
- 别人用昵称以外的名字称呼某人 → `source: "others_call"`
- 提取核心形式：各种变形（加前后缀、中间插字、谐音梗）提取最本质的称呼。如"星野酱""小星野""史蒂夫野"→ name 填"星野"

### 6.8 closeness_tier 规则引擎

后端用，不注入 prompt：

```typescript
function computeClosenessTier(
  total: number,           // interactionCount
  lastInteraction: number, // 上次互动时间
  currentTier: ClosenessTier,
): ClosenessTier {
  const daysSince = (Date.now() - lastInteraction) / 86400_000

  // 30 天无互动：降一级
  if (daysSince > 30) {
    return downgrade(currentTier)  // close→familiar→acquaintance→stranger
  }

  if (total >= 50) return 'close'
  if (total >= 15) return 'familiar'
  if (total >= 3) return 'acquaintance'
  return 'stranger'
}
```

**closeness_tier 的 prompt 展示标签**：

| Tier | 标签 |
|------|------|
| `close` | "老聊友了" |
| `familiar` | "挺熟的" |
| `acquaintance` | "偶尔聊几句" |
| `stranger` | "不太熟" |

### 6.9 关于没有称呼时的行为

当 `preferredName` 为 null 且 `displayName` 不像真实名字时，不标注任何称呼。澪在回复时会自然地用"你"或引用消息，而不是硬叫一个不确定的名字——这正是真人在不知道叫什么的时候的行为。

---

## 7. 提取调度（Extraction Scheduler）

### 7.1 问题

不能每次 debounce 后都触发 extraction —— 高峰期消息频繁，大部分日常闲聊不需要 LLM 提取。需要一个调度器来决定何时触发。

### 7.2 架构

```typescript
interface ExtractionSchedulerConfig {
  minMessages: number      // 触发批量提取的最小消息数（25-40）
  maxWaitMinutes: number   // 最大等待时间（15 分钟）
  activeThreshold: number  // 澪参与后的快速提取阈值（5）
}
```

### 7.3 触发条件

| 条件 | 说明 | 典型值 |
|------|------|--------|
| **批量触发** | 累积消息数 >= minMessages | 25-40 条 |
| **超时触发** | 距上次提取 > maxWaitMinutes 且 count > 0 | 15 分钟 |
| **主动参与触发** | 澪发言后，后续又累积 >= activeThreshold 条消息 | 5 条 |

超时检查每 5 分钟运行一次，检查所有启用的群。

### 7.4 与 v4 设计中"快慢通道"的对比

v4 修改方案提出了 triage（快通道）+ extraction（慢通道）的双 LLM 调用架构。**当前实现采用了单次 extraction 调用 + 调度器的方案**——由调度器决定何时触发提取（解决了"大部分灌水不需要提取"的问题），触发后执行一次包含所有字段的 extraction LLM 调用。

这样做的原因：
- 调度器已经通过消息计数和超时机制过滤了大部分不值得提取的低价值对话
- 单次 LLM 调用比双次调用更简单，延迟更低
- vibes 和 name_observations 不需要单独的快通道，因为它们在每次提取中都会被处理

---

## 8. 记忆的 Prompt 注入策略

### 8.1 System Prompt 结构

```
┌─── 静态部分（最大化前缀缓存命中）───┐
│ Layer 0: 认知框架                     │
│ Layer 1: 行为原则                     │
│ Layer 2: 输出格式说明                 │
│ Layer 3: 人设                         │
│ Layer 4: Few-Shot 示范                │
└───────────────────────────────────────┘
┌─── 动态部分 ──────────────────────────┐
│ 记忆上下文 ← 记忆系统的主战场          │
│ 当前时间                              │
│ 群聊消息记录                          │
│ 尾部锚定                              │
└───────────────────────────────────────┘
```

### 8.2 记忆上下文的组装

由 `ContextAssembler` 负责，输出三个文本块：

```typescript
interface MemoryContext {
  userProfile: string     // 参与者印象文本
  memories: string        // 召回的 episodic 记忆文本
  groupCulture: string    // 群文化 facts 文本
}
```

### 8.3 完整注入格式

```
---
【你脑海中浮现的一些印象和记忆——这只是背景，不是你现在的情绪。该怎么反应看当下的对话。】

关于今天参与对话的人：
- 10003 （大家叫他阿K）: 老聊友了。聊 gal 和音乐都很合得来。
  前天他推荐了一首歌很对味。（他也喜欢近月 有点开心）
  你还记得：原来也玩key的 之前只玩过lb 品味还行
- 10456 （大家叫他星野）: 偶尔聊几句。好像是大三的，提过在准备什么考试。
- 10789: 不太熟。

你对这个群的了解：
- 群里说草就是在笑的意思
- 群里有个骰子bot 发/r可以掷骰子

你有印象的最近的一些事：
- 前天 阿K通完了clannad 之前只玩过lb 聊了一下after story
- 3 天前 E打完了近月少女的礼仪 是被我之前提到的安利的

（以下是你在群里看到但没参与的——你知道发生过，但别人不知道你看过）
- 昨天 鱼的论文被打回来三次了 导师让重做实验 看起来挺焦虑的
```

### 8.4 参与者描述的构建逻辑

```typescript
function buildParticipantContext(groupId, userId): string {
  const rel = getRelationship(groupId, userId)

  // 1. userId + 称呼前缀
  let line = `- ${userId}`
  if (rel.preferredName) {
    line += ` （大家叫他${rel.preferredName}）`
  } else if (looksLikeRealName(rel.displayName)) {
    line += ` （昵称${rel.displayName}）`
  }

  // 2. closeness 描述
  const parts = [CLOSENESS_LABELS[rel.closenessTier]]

  // 3. 核心印象
  if (rel.coreImpression) parts.push(rel.coreImpression)

  // 4. 近期印象
  if (rel.recentImpression) parts.push(rel.recentImpression)

  line += `: ${parts.join('。')}`

  // 5. Session vibe
  const vibe = workingMemory.getSessionVibe(groupId, userId)
  if (vibe) line += `（${vibe.vibe}）`

  // 6. 补充 semantic facts（未被 impression 覆盖的，top-3，confidence >= 0.3）
  const additionalFacts = getActiveFacts(userId)
    .filter(f => f.factType !== 'preferred_name')
    .filter(f => f.confidence >= 0.3)
    .filter(f => !isContentCovered(f.content, impressionText))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3)
  if (additionalFacts.length > 0) {
    line += `\n  你还记得：${additionalFacts.map(f => f.content).join('。')}`
  }

  return line
}
```

**名字判断**：`looksLikeRealName()` 要求长度 2-10，且 > 70% 的字符是中文/英文/数字（过滤 emoji 和符号昵称）。

**Facts 去重**：提取 fact content 中 >= 2 字的关键词，如果 > 50% 在 impression 文本中出现，认为已涵盖。

### 8.5 群文化上下文

```typescript
function buildGroupCulture(groupId): string {
  // 加载 subject="group" 且 confidence >= 0.4 的 active facts
  // 按 confidence 降序，最多 15 条
  return facts.map(f => `- ${f.content}`).join('\n')
}
```

### 8.6 Less is More

**宁可注入少量高质量记忆，也不要塞满低相关度的信息。**

- 注入太多 → LLM 过度引用，每句话都在 reference 过去
- 真人只有被触发的记忆才会浮现
- 不相关的记忆是噪音

**经验法则**：如果一条记忆跟当前对话没有直接或间接的关联，就不要注入。记忆上下文前面有一句锚定："这只是背景，不是你现在的情绪。该怎么反应看当下的对话。"

---

## 9. 蒸馏流程（每日）

### 9.1 总览

```
每日凌晨（默认 3:00，configurable）
    │
    ▼
[对每个活跃群执行]
    │
    ├─→ [Step 0: Embedding 补充]
    │     补充缺失 embedding（历史数据修复，批量 100 条）
    │
    ├─→ [Step 1: Semantic Facts 维护]
    │     输入：近 7 天 episodic + 现有 active semantic facts
    │     输出：new / confirmed / evolved / decayed facts
    │
    ├─→ [Step 2: Recent Impression 重写]（对每个近 7 天有互动的用户）
    │     输入：该用户近 7 天的 active facts + core_impression
    │     输出：新 recent_impression（≤60 字）
    │
    ├─→ [Step 3: Core Impression 条件更新]（仅满足条件的用户）
    │     条件：>= 3 active facts && (新用户 || core 超 30 天未更新)
    │     输入：该用户 top-15 facts
    │     输出：unchanged 或 new_impression（≤80 字）
    │
    ▼
[全局 Step 4: 清理]
    ├─→ Episodic: eventTime < 21 天 → archived
    └─→ Episodic: 活跃数 > activePoolLimit → 淘汰最早的
```

### 9.2 Step 0: Embedding 补充

蒸馏开始前，检查 episodic 和 semantic 表中有无 embedding 为空的记录。如果有，批量生成并回填（每批最多 100 条）。这是一个容错机制——正常流程中 embedding 应在提取时生成，但如果当时 API 失败，这里可以补上。

### 9.3 Step 1: Semantic Facts 维护

**输入**：
- 该群近 7 天的 episodic memories（纯时间窗口，不区分是否已蒸馏过）
- 该群所有 active semantic facts（`supersededBy == null`）

**LLM 调用**：
- Prompt: `semantic_distill`（见附录）
- Temperature: 0.5, Max tokens: 8192
- 模型：配置的 `distillation` 模型

**输出处理**：

```json
{
  "new_facts": [
    {"subject": "userId 或 group", "fact_type": "...", "content": "第一人称叙事", "confidence": 0~1}
  ],
  "confirmed_facts": [
    {"id": 数字, "new_confidence": 0~1}
  ],
  "evolved_facts": [
    {"old_fact_id": 数字, "new_content": "含时间演进的新叙事", "new_confidence": 0~1}
  ],
  "decayed_facts": [
    {"id": 数字, "new_confidence": 0~1}
  ]
}
```

**new_facts 的去重**：每条新 fact 生成 embedding 后，与已有 active facts 比较（相同 subject + factType + cosine >= 0.9 = 重复），重复时只 bump confidence +0.1（cap 1.0）。

**evolved_facts 的处理**：创建新 fact（包含时间线叙事），旧 fact 标记 `supersededBy = 新 fact id`。

### 9.4 Step 2: Recent Impression 重写

**触发条件**：该用户 `lastInteraction` 在近 7 天内。

**输入**：
- 该用户近 7 天的 active semantic facts
- 当前的 core_impression

**LLM 调用**：
- Prompt: `recent_impression`
- Temperature: 0.3, Max tokens: 200

**输出**：`{"recent_impression": "..."}` — 截断到 60 字。

**关键**：不读旧 recent_impression，每次都从源头 facts 重新生成。

### 9.5 Step 3: Core Impression 条件更新

**触发条件（全部满足）**：
1. 该用户的 active semantic facts >= 3
2. `coreImpression` 为空（新用户），**或** core_impression 更新于 > 30 天前

**输入**：该用户 top-15 active facts（按 confidence 降序）

**LLM 调用**：
- Prompt: `core_impression`
- Temperature: 0.3, Max tokens: 200

**输出**：`{"unchanged": true}` 或 `{"unchanged": false, "new_impression": "..."}` — 截断到 80 字。

### 9.6 Step 4: 清理

- **时间过期**：`eventTime < 21 天前` → `archived = true`
- **容量驱逐**：活跃 episodic > `activePoolLimit`（200）→ 按 `eventTime` 升序淘汰最早的

### 9.7 为什么拆成独立步骤？

- 一次 LLM Call 要同时做 Semantic + Relational，prompt 会极其复杂
- 拆开后每个 prompt 更聚焦，输出质量更高
- 可以对每一步独立调试
- 如果某一步失败不影响其他步骤

---

## 10. 存储方案

### 10.1 技术选型

**SQLite（通过 Koishi ORM）+ JSON 字段 + Embedding JSON + Working Memory 内存缓冲。**

Koishi 的 ORM 层抽象了数据库操作，表定义通过 `ctx.model.extend()` 声明。

### 10.2 表结构

```typescript
// 表 1: mio.episodic — 情节记忆
{
  id: 'unsigned',                    // 自增主键
  groupId: 'string(63)',
  summary: 'text',
  participants: { type: 'json', initial: [] },     // string[]
  tags: { type: 'json', initial: [] },             // string[]
  embedding: { type: 'json', initial: [] },        // number[]
  importance: { type: 'float', initial: 0.5 },
  emotionalValence: { type: 'float', initial: 0 },
  emotionalIntensity: { type: 'float', initial: 0 },
  mioInvolvement: { type: 'string', initial: 'observer' },
  eventTime: 'unsigned(8)',
  archived: { type: 'boolean', initial: false },
  createdAt: 'unsigned(8)',
}

// 表 2: mio.relational — 关系记忆
{
  id: 'unsigned',                    // 自增主键
  groupId: 'string(63)',
  userId: 'string(63)',              // unique: [['groupId', 'userId']]
  displayName: 'string(255)',
  coreImpression: { type: 'text', initial: '' },
  coreImpressionUpdatedAt: 'unsigned(8)',
  recentImpression: { type: 'text', initial: '' },
  recentImpressionUpdatedAt: 'unsigned(8)',
  closenessTier: { type: 'string', initial: 'stranger' },
  interactionCount: { type: 'unsigned', initial: 0 },
  lastInteraction: 'unsigned(8)',
  knownNames: { type: 'text', initial: '[]' },     // JSON: NameObservation[]
  preferredName: { type: 'string', nullable: true, initial: null },
  createdAt: 'unsigned(8)',
  updatedAt: 'unsigned(8)',
}

// 表 3: mio.semantic — 语义记忆（含群文化）
{
  id: 'unsigned',                    // 自增主键
  groupId: 'string(63)',
  subject: 'string(255)',            // userId 或 "group"
  factType: { type: 'string', initial: 'trait' },
  content: { type: 'text', initial: '' },
  embedding: { type: 'json', initial: [] },        // number[]（用于去重）
  confidence: { type: 'float', initial: 0.5 },
  sourceEpisodes: { type: 'json', initial: [] },   // number[]
  firstObserved: 'unsigned(8)',
  lastConfirmed: 'unsigned(8)',
  supersededBy: { type: 'unsigned', nullable: true, initial: null },
  createdAt: 'unsigned(8)',
}
```

**注**：还有 `mio.sticker`（表情包系统）和 `mio.token_usage`（token 统计）两张表，与记忆系统无关，这里不展开。

---

## 11. 完整数据流

### 11.1 写入流程（对话后）

```
群聊消息到来
    │
    ▼
[Debouncer + 意愿度系统] ──→ 澪回复（或沉默）
    │
    ▼
[Extraction Scheduler 决策]
    │
    ├─→ 不触发（消息数不够 / 未超时 / 澪未参与）→ 计数 +1，等待
    │
    └─→ 触发提取
          │
          ▼
        [消息分块]（每块 ≤ 30 条，5 分钟间隔断点）
          │
          ▼
        [记忆提取 LLM Call]（每个 chunk 独立调用）
          │
          ├─→ name_observations[] → name-learning 直写 mio.relational
          │
          ├─→ cultural_observations[] → culture-learning 直写 mio.semantic
          │     （embedding 去重，cosine >= 0.85 → bump confidence）
          │
          ├─→ relationship_observations[] → person-learning 直写
          │     ├─→ semantic facts（embedding 去重，直写 mio.semantic）
          │     └─→ relational metadata（interactionCount, closenessTier, displayName）
          │
          ├─→ episodes[] → [Embedding API] → Working Memory
          │     （双重去重：vs pending + vs DB，cosine > 0.9 跳过）
          │
          └─→ vibes[] → Working Memory（即时生效，TTL 1-8 小时）
    │
    ▼
[Working Memory flush 计时器重置]
    │
    └─→ 5 分钟无新写入 → 批量 flush episodic 到 SQLite
        或 pending 达到 20 条 → 立即 flush
```

### 11.2 读取流程（回复前）

```
新消息到来，准备调用主 LLM
    │
    ▼
[取最近 5 条消息拼接作为 query]
    │
    ├─→ [生成 query embedding]
    │
    ├─→ 混合检索 Episodic Memory
    │     DB 持久记忆 + Working Memory pending 记忆
    │     score = similarity×0.5 + timeDecay×0.2 + importance×0.1 + tagBoost×0.2
    │     过滤：chatHistoryStart 之后的记忆不注入
    │     → top-5
    │
    ├─→ 加载参与者 relationship
    │     + session_vibe（仅 Working Memory，检查过期）
    │     + preferredName（称呼）
    │
    ├─→ 加载参与者相关 semantic_facts
    │     （active, confidence >= 0.3, 排除 preferred_name）
    │     去重：与 impression 文本 keyword overlap > 50% → 跳过
    │     → top-3 per user
    │
    ├─→ 加载 subject="group" 的 semantic_facts
    │     （active, confidence >= 0.4, top-15）
    │
    ▼
[组装 MemoryContext → 注入 System Prompt]
    │
    ▼
[LLM 生成回复]
```

### 11.3 蒸馏流程（每日）

```
每日凌晨（configurable，默认 3:00）
    │
    ▼
[对每个活跃群]
    │
    ├─→ Step 0: Embedding 补充（修复缺失的向量）
    │
    ├─→ Step 1: Semantic Facts 维护
    │     输入：近 7 天 episodic + 现有 active facts
    │     LLM → new_facts / confirmed / evolved / decayed
    │     new_facts embedding 去重（cosine >= 0.9 → bump）
    │
    ├─→ Step 2: Recent Impression 重写（仅近 7 天有互动的用户）
    │     输入：该用户近 7 天 active facts + core_impression
    │     LLM → recent_impression（≤60 字）
    │
    └─→ Step 3: Core Impression 条件更新
          仅对 activeFacts >= 3 && (新用户 || core > 30 天) 的用户
          LLM → unchanged 或 new_impression（≤80 字）
    │
    ▼
[全局 Step 4: 清理]
    ├─→ Episodic: eventTime < 21 天 → archived
    └─→ Episodic: 活跃数 > 200 → 淘汰最早的
```

---

## 12. 配置

```typescript
memory: {
  enabled: boolean,                    // 主开关（默认 false）
  embedding: {
    providerId: string,                // 默认 "openai"
    modelName: string,                 // 默认 "text-embedding-3-small"
  },
  extraction: {
    providerId: string,                // 默认 "deepseek"
    modelName: string,                 // 默认 "deepseek-chat"
    temperature: number,               // 默认 0.3
    maxTokens: number,                 // 默认 800
  },
  distillation: {
    providerId: string,                // 默认 "deepseek"
    modelName: string,                 // 默认 "deepseek-chat"
    temperature: number,               // 默认 0.3
    maxTokens: number,                 // 默认 1000
  },
  distillationHour: number,            // 每日蒸馏时间（默认 3，即凌晨 3 点）
  flushIntervalMs: number,             // Working Memory flush 间隔（默认 300000 = 5 分钟）
  maxPendingWrites: number,            // 触发立即 flush 的 pending 数量（默认 20）
  activePoolLimit: number,             // 活跃 episodic 记忆池上限（默认 200）
}
```

---

## 13. 关键设计决策汇总

### 13.1 核心特点

| 设计决策 | 原理 |
|---------|------|
| **叙事驱动的关系** | 人记忆关系用故事和偏见，不用 Excel |
| **三层印象分离** | 核心/近期/当下 对应 月/周/小时 的时间尺度 |
| **session_vibe 即时生效** | 情绪惯性不能等隔夜蒸馏 |
| **core 不参与每日重写** | 防止 LLM 反复重写导致的"传话筒"磨损 |
| **recent 从源头 facts 重新生成** | 不读自己的旧输出，避免幻觉累积 |
| **时间线叙事处理矛盾** | "以前喜欢X现在偏向Y" 比布尔标记更自然更稳健 |
| **第一人称语义事实** | 人脑里没有客观事实，只有"我觉得的事实" |
| **Working Memory 缓冲** | 高频写入吸收，双重去重 |
| **embedding 混合检索** | 模糊联想 > 精确匹配 |
| **群文化归入 Semantic** | 不需要独立模块，subject="group" 的 facts 足够覆盖 |
| **调度器控制提取频率** | 不是每次 debounce 都提取，攒批 + 超时 + 主动参与三路触发 |
| **提取时直写 + 蒸馏维护** | 即时的观察（人物/文化/称呼）直写 DB，蒸馏负责跨对话积累和维护 |
| **蒸馏步骤拆分** | 每步独立聚焦，质量更高，可独立调试 |
| **称呼学习** | 像真人一样通过观察学习怎么叫一个人 |

### 13.2 潜在风险与缓解

#### ❓ LLM Call 开销

**缓解**：
- 记忆提取用便宜模型（默认 DeepSeek）
- 调度器过滤了大部分不需要提取的对话
- 蒸馏每天只跑一次
- Embedding API 成本极低

#### ❓ Embedding API 延迟和成本

**缓解**：
- 异步执行，不阻塞回复
- 批量请求（`embedBatch`）
- 单条成本极低
- 可通过切换 providerId 迁移到本地模型

#### ❓ impression 蒸馏质量

**可能的问题**：
- core 写得不像内心想法而像报告
- recent 和 core 内容重复
- session_vibe 措辞不当

**缓解**：
- 蒸馏 prompt 强制字数限制
- few-shot 示范正确口吻
- recent 每次从源头重新生成，不会累积误差

#### ❓ Working Memory 数据丢失

进程崩溃时未 flush 的 episodic 数据会丢失。

**缓解**：
- 可接受——丢失最近几分钟的提取结果
- session_vibe 本身就是短命的
- 直写通道的数据（name/culture/person）不经过 Working Memory，不受影响
- core_impression 等在蒸馏时写入 SQLite，不经过 Working Memory

#### ❓ 冷启动

**缓解**：
- 新用户默认 stranger + 空 impression（这本身合理）
- 部署后正常使用即可自然积累记忆
- 如有历史聊天记录，可手动批量初始化

#### ❓ 隐私

- 数据只在本地 SQLite
- 不存储过于敏感的信息
- 考虑"忘记我"功能（删除特定 userId 的所有记忆）

---

## 14. 与现有系统的集成点

| 现有模块 | 集成方式 |
|---------|---------|
| **Debouncer** | debounce 结束后，extraction scheduler 决定是否触发提取 |
| **意愿度系统** | impression + session_vibe 作为上下文自然影响 LLM 输出 |
| **图片理解** | 图片描述可成为 episodic memory 的一部分 |
| **搜索增强** | 搜索结果不进入记忆（"查到的"不是"经历的"） |
| **Layer 0-4 Prompt** | 记忆系统只影响 Layer 3 之后的动态部分 |
| **表情包系统** | 蒸馏定时器同时触发表情包的日维护 |

---

## 15. 代码文件索引

| 文件 | 职责 |
|------|------|
| `src/memory/index.ts` | MemoryService 主入口，编排读取/写入/蒸馏 |
| `src/memory/types.ts` | 所有类型定义 |
| `src/memory/tables.ts` | ORM 表声明 + 行类型 |
| `src/memory/working-memory.ts` | 内存缓冲层（pending episodic + session vibes） |
| `src/memory/extraction.ts` | 记忆提取（分块 + LLM 调用 + 结果解析） |
| `src/memory/extraction-scheduler.ts` | 提取调度器（批量/超时/主动参与三路触发） |
| `src/memory/episodic.ts` | Episodic 混合检索（embedding + time + tag） |
| `src/memory/embedding.ts` | Embedding 服务（API 封装 + cosine similarity） |
| `src/memory/distillation.ts` | 蒸馏 pipeline（4 步：embedding 补充 → semantic → impression → 清理） |
| `src/memory/context-assembler.ts` | Layer 3 上下文组装（userProfile + memories + groupCulture） |
| `src/memory/name-learning.ts` | 称呼学习（直写 relational） |
| `src/memory/culture-learning.ts` | 群文化观察处理（直写 semantic, subject="group"） |
| `src/memory/person-learning.ts` | 人物观察处理（直写 semantic + relational） |
| `src/memory/prompt-manager.ts` | Prompt 模板管理 |
| `src/context/prompt-builder.ts` | System Prompt 构建（静态层 + 动态记忆注入） |
| `src/runtime/conversation.ts` | 运行时集成点（触发记忆读取和提取） |
| `data/prompts.yaml` | 所有 prompt 模板 |
| `src/config.ts` | 配置 schema（含 memory 部分） |

import { Context, Schema, Session, h, Universal } from "koishi";
import * as fs from 'fs';
import { MessageBuffer } from "./pipeline/message-buffer";
import { NormalizedMessage } from "./perception/types";
import { Debouncer } from "./pipeline/debouncer";
import { LLMClient } from "./llm/client";
import { ProviderManager, ProviderConfig, ModelConfig } from "./llm/provider";
import { PromptBuilder } from "./context/prompt-builder";
import { humanizedSend, resolveAtMentions, levenshtein, UserInfo } from "./delivery/humanize";
import { ImageProcessor } from "./pipeline/image-processor";
import { MemoryService } from "./memory";
import { MemoryExtractionScheduler } from "./memory/extraction-scheduler";
import { reloadPrompts, getPromptManager } from "./memory/prompt-manager";
import { SearchService } from "./search/router";
import { StickerService } from "./sticker";
import { tokenTracker, extendTokenTable, TokenStats } from "./llm/token-tracker";
import type { SearchRequest, Action, LLMResponse } from "./types/response";
import { MessageNormalizer } from "./perception/normalizer";
import { ContextRenderer } from "./perception/renderer";
import { getEmojiById, getEmojiByName, getAllEmojis } from '@wittf/koishi-plugin-adapter-onebot';
import type { OneBotBot } from '@wittf/koishi-plugin-adapter-onebot';
import { } from '@wittf/koishi-plugin-adapter-onebot';
import { } from '@koishijs/plugin-console';
import * as path from 'path';

declare module '@koishijs/plugin-console' {
  interface Events {
    'mio/memory-stats'(): Promise<{
      enabled: boolean
      episodic: { active: number; archived: number }
      relational: number
      semantic: number
    }>
    'mio/trigger-distillation'(): Promise<string>
    'mio/flush-memory'(): Promise<string>
    'mio/migrate-participants'(): Promise<string>
    'mio/token-stats'(): Promise<TokenStats>
    'mio/token-stats-reset'(): Promise<string>
  }
}

const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

function stickerMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return MIME_TYPES[ext] ?? 'image/jpeg';
}


/**
 * 精确匹配 QQ 表情名，失败时用编辑距离模糊匹配（阈值 ≤ 2）
 */
function findEmoji(name: string): { id: string; name: string } | null {
  const exact = getEmojiByName(name);
  if (exact) return exact;

  const all = getAllEmojis();
  let best: (typeof all)[0] | null = null;
  let bestDist = Infinity;
  for (const emoji of all) {
    const dist = levenshtein(name, emoji.name);
    if (dist < bestDist) {
      bestDist = dist;
      best = emoji;
    }
  }
  return best && bestDist <= 2 ? best : null;
}

export const name = "mio";

export const inject = ["database"];

export interface Config {
  botName: string;
  botAliases: string[];
  personaFile: string;
  enableGroups: string[];
  providers: ProviderConfig[];
  models: {
    chat: ModelConfig;
    vision: ModelConfig;
  };
  bufferSize: number;
  debounce: {
    idleMs: number;
    minWaitMs: number;
    maxWaitMs: number;
  };
  vision: {
    enabled: boolean;
  };
  safety: {
    maxReplyPerHour: number;
    minCooldownMs: number;
    maxConsecutiveReplies: number;
  };
  memory: {
    enabled: boolean;
    embedding: ModelConfig;
    extraction: ModelConfig;
    distillation: ModelConfig;
    distillationHour: number;
    flushIntervalMs: number;
    maxPendingWrites: number;
    activePoolLimit: number;
  };
  search: {
    enabled: boolean;
    searxngBaseUrl: string;
    bangumiUserAgent: string;
    searchTimeoutMs: number;
    compression: ModelConfig;
  };
  sticker: {
    enabled: boolean;
    imageDir: string;
    poolSize: number;
  };
}

export const Config: Schema<Config> = Schema.object({
  botName: Schema.string().default("澪").description("Bot 名称"),
  botAliases: Schema.array(Schema.string())
    .default(["みお", "小澪"])
    .description("Bot 别名"),
  personaFile: Schema.string().default("mio.md").description("人设文件名"),
  enableGroups: Schema.array(Schema.string().pattern(/^\d+$/))
    .default([])
    .description("启用的群号"),
  bufferSize: Schema.number().default(50).description("消息缓冲区大小"),

  providers: Schema.array(
    Schema.object({
      id: Schema.string().required().description("供应商 ID（自定义，如 deepseek-main）"),
      name: Schema.string().required().description("供应商名称（显示用）"),
      type: Schema.union(['openai', 'gemini'] as const)
        .default('openai')
        .description("供应商类型（openai: OpenAI-compatible API, gemini: Google Gemini API）"),
      apiKey: Schema.string().required().description("API Key"),
      baseUrl: Schema.string().description("API Base URL（仅 OpenAI-compatible 需要）"),
    })
  )
    .default([
      {
        id: "deepseek",
        name: "DeepSeek",
        type: "openai",
        apiKey: "",
        baseUrl: "https://api.deepseek.com",
      },
    ])
    .description("LLM 供应商配置"),

  models: Schema.object({
    chat: Schema.object({
      providerId: Schema.string().default("deepseek").description("使用的供应商 ID"),
      modelName: Schema.string().default("deepseek-chat").description("模型名称"),
      temperature: Schema.number().default(0.9).description("温度参数"),
      maxTokens: Schema.number().default(200).description("最大 Token 数"),
      thinkingBudget: Schema.number().description("Gemini thinking 预算 token 数（0=禁用，不填=模型默认）"),
    }).description("对话生成模型"),
    vision: Schema.object({
      providerId: Schema.string().default("deepseek").description("使用的供应商 ID"),
      modelName: Schema.string().default("deepseek-chat").description("多模态模型名称（如 gpt-4o-mini）"),
      temperature: Schema.number().default(0.5).description("温度参数"),
      maxTokens: Schema.number().default(500).description("最大 Token 数（Gemini thinking 模型需要更大值）"),
      thinkingBudget: Schema.number().description("Gemini thinking 预算 token 数（0=禁用，不填=模型默认）"),
    }).description("图片理解模型"),
  }).description("模型配置"),

  debounce: Schema.object({
    idleMs: Schema.number().default(5000).description("消息间隔窗口期（毫秒）"),
    minWaitMs: Schema.number().default(8000).description("基准最短等待时间（毫秒）"),
    maxWaitMs: Schema.number().default(45000).description("基准最长等待时间（毫秒）"),
  }).description("Debounce 配置"),

  vision: Schema.object({
    enabled: Schema.boolean().default(true).description("启用图片理解功能"),
  }).description("多模态配置"),

  safety: Schema.object({
    maxReplyPerHour: Schema.number().default(25).description("每小时最多回复次数"),
    minCooldownMs: Schema.number().default(15000).description("最小回复冷却时间（毫秒）"),
    maxConsecutiveReplies: Schema.number().default(4).description("最多连续回复次数（之后静默）"),
  }).description("安全兜底配置"),

  memory: Schema.object({
    enabled: Schema.boolean().default(false).description("启用记忆系统"),
    embedding: Schema.object({
      providerId: Schema.string().default("openai").description("Embedding 供应商 ID"),
      modelName: Schema.string().default("text-embedding-3-small").description("Embedding 模型名称"),
    }).description("Embedding 模型配置"),
    extraction: Schema.object({
      providerId: Schema.string().default("deepseek").description("记忆提取供应商 ID"),
      modelName: Schema.string().default("deepseek-chat").description("记忆提取模型名称"),
      temperature: Schema.number().default(0.3).description("温度参数"),
      maxTokens: Schema.number().default(800).description("最大 Token 数"),
    }).description("记忆提取模型配置（建议用便宜模型）"),
    distillation: Schema.object({
      providerId: Schema.string().default("deepseek").description("蒸馏供应商 ID"),
      modelName: Schema.string().default("deepseek-chat").description("蒸馏模型名称"),
      temperature: Schema.number().default(0.3).description("温度参数"),
      maxTokens: Schema.number().default(1000).description("最大 Token 数"),
    }).description("蒸馏模型配置（可复用提取模型）"),
    distillationHour: Schema.number().default(3).description("每日蒸馏时间（0-23，默认凌晨 3 点）"),
    flushIntervalMs: Schema.number().default(300000).description("Working Memory flush 间隔（毫秒）"),
    maxPendingWrites: Schema.number().default(20).description("最大缓冲写入数"),
    activePoolLimit: Schema.number().default(200).description("活跃记忆池上限"),
  }).description("记忆系统配置"),

  search: Schema.object({
    enabled: Schema.boolean().default(true).description("启用搜索增强功能"),
    searxngBaseUrl: Schema.string().default("http://localhost:18080").description("SearXNG 实例地址"),
    bangumiUserAgent: Schema.string().default("starrydream/mio-bot/1.0").description("Bangumi API User-Agent"),
    searchTimeoutMs: Schema.number().default(3000).description("搜索超时时间（毫秒）"),
    compression: Schema.object({
      providerId: Schema.string().default("deepseek").description("搜索结果压缩供应商 ID"),
      modelName: Schema.string().default("deepseek-chat").description("搜索结果压缩模型名称"),
      temperature: Schema.number().default(0).description("温度参数（压缩任务建议 0）"),
      maxTokens: Schema.number().default(150).description("最大 Token 数"),
    }).description("搜索结果压缩模型配置（建议用便宜快速的模型）"),
  }).description("搜索增强配置"),

  sticker: Schema.object({
    enabled: Schema.boolean().default(true).description('启用表情包收集功能'),
    imageDir: Schema.string().default('./data/stickers').description('表情包存储目录'),
    poolSize: Schema.number().default(80).description('活跃池软上限'),
  }).description('表情包系统配置'),
});


/**
 * 检查消息是否显式触发 bot（@ 或提名字）
 */
function isMentioningBot(content: string, config: Config): boolean {
  const lowerContent = content.toLowerCase();
  const names = [config.botName, ...config.botAliases].map(n => n.toLowerCase());
  return names.some(name => lowerContent.includes(name));
}

/**
 * 统计最近消息中连续的 bot 回复数
 */
function countTrailingBotMessages(messages: NormalizedMessage[]): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].isBot) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/**
 * 验证 LLM 响应格式
 */
function validateResponse(response: LLMResponse, logger: any): void {
  // If search is set, ignore silent and actions
  if (response.search) {
    if (response.actions && response.actions.length > 0) {
      logger.warn('Response has search set but non-empty actions, actions will be ignored');
    }
    return;
  }

  // If silent is true, actions should be empty (warn if not)
  if (response.silent && response.actions && response.actions.length > 0) {
    logger.warn('Response has silent=true but non-empty actions, ignoring actions');
  }

  // If silent is false, actions should not be empty (warn if empty)
  if (!response.silent && (!response.actions || response.actions.length === 0)) {
    logger.warn('Response has silent=false but empty actions');
  }
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger("mio");

  // 重载 prompt 模板（支持热更新）
  reloadPrompts();

  // 验证配置
  if (!config?.providers || config.providers.length === 0) {
    logger.warn("未配置任何 LLM 供应商，插件将不会工作");
    return;
  }

  // 验证所有供应商都有 API Key
  const invalidProviders = config.providers.filter(p => !p.apiKey);
  if (invalidProviders.length > 0) {
    logger.warn(`以下供应商缺少 API Key: ${invalidProviders.map(p => p.id).join(', ')}`);
    return;
  }

  // 初始化供应商管理器
  const providerManager = new ProviderManager(config.providers);

  // 验证模型配置引用的供应商存在
  if (!providerManager.hasProvider(config.models.chat.providerId)) {
    logger.warn(`对话模型引用的供应商不存在: ${config.models.chat.providerId}`);
    return;
  }
  if (config.vision.enabled && !providerManager.hasProvider(config.models.vision.providerId)) {
    logger.warn(`图片理解模型引用的供应商不存在: ${config.models.vision.providerId}`);
    return;
  }

  const buffer = new MessageBuffer(config.bufferSize);
  const debouncer = new Debouncer(config.debounce);
  const llm = new LLMClient(providerManager);
  const promptBuilder = new PromptBuilder(config.personaFile);

  // 初始化 Token 用量追踪
  extendTokenTable(ctx);
  tokenTracker.init(ctx);
  const tokenFlushInterval = setInterval(() => tokenTracker.flush(), 60_000);
  ctx.on('dispose', async () => {
    clearInterval(tokenFlushInterval);
    await tokenTracker.flush();
  });

  // 初始化图片处理器
  const imageProcessor = config.vision.enabled
    ? new ImageProcessor(llm, config.models.vision)
    : null;

  // 初始化感知层
  const normalizer = new MessageNormalizer(imageProcessor, config.botName);
  const renderer = new ContextRenderer();

  // 初始化记忆系统
  let memory: MemoryService | null = null;
  if (config.memory?.enabled) {
    // 验证 embedding 供应商存在
    if (!providerManager.hasProvider(config.memory.embedding.providerId)) {
      logger.warn(`Embedding 供应商不存在: ${config.memory.embedding.providerId}，记忆系统已禁用`);
    } else if (!providerManager.hasProvider(config.memory.extraction.providerId)) {
      logger.warn(`记忆提取供应商不存在: ${config.memory.extraction.providerId}，记忆系统已禁用`);
    } else if (config.memory.distillation?.providerId && !providerManager.hasProvider(config.memory.distillation.providerId)) {
      logger.warn(`蒸馏供应商不存在: ${config.memory.distillation.providerId}，记忆系统已禁用`);
    } else {
      memory = new MemoryService(ctx, providerManager, llm, config.memory);
      memory.init();
      memory.startDistillationScheduler();
      logger.info(`记忆系统已启用 (embedding: ${config.memory.embedding.providerId}/${config.memory.embedding.modelName})`);
    }
  }

  // 初始化搜索服务
  let searchService: SearchService | null = null;
  if (config.search?.enabled) {
    // 验证压缩模型供应商存在
    if (!providerManager.hasProvider(config.search.compression.providerId)) {
      logger.warn(`搜索压缩供应商不存在: ${config.search.compression.providerId}，搜索功能已禁用`);
    } else {
      searchService = new SearchService(llm, {
        searxngBaseUrl: config.search.searxngBaseUrl,
        bangumiUserAgent: config.search.bangumiUserAgent,
        searchTimeoutMs: config.search.searchTimeoutMs,
        compressionModel: config.search.compression,
      });
      logger.info(`搜索增强已启用 (compression: ${config.search.compression.providerId}/${config.search.compression.modelName})`);
    }
  }

  // 初始化表情包系统
  let stickerService: StickerService | null = null;
  if (config.sticker?.enabled && memory) {
    stickerService = new StickerService(ctx, memory.getEmbeddingService(), {
      enabled: true,
      imageDir: config.sticker.imageDir,
      maxPoolSize: config.sticker.poolSize,
    });
    memory.setStickerService(stickerService);
    logger.info('表情包系统已启用');

    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    const weeklyTimer = setInterval(async () => {
      await stickerService!.runWeeklyDedup();
      logger.info('表情包周去重完成');
    }, WEEK_MS);
    ctx.on('dispose', () => clearInterval(weeklyTimer));
  }

  // 初始化记忆提取调度器
  let extractionScheduler: MemoryExtractionScheduler | null = null;
  if (memory) {
    extractionScheduler = new MemoryExtractionScheduler({
      minMessages: 30,           // 累积 30 条消息触发批量提取
      maxWaitMinutes: 15,        // 最多等 15 分钟
      activeThreshold: 8,        // 澪参与后再累积 8 条消息触发快速提取
    });
    logger.info('记忆提取调度器已启用 (batch: 30 条, timeout: 15 分钟, active: 8 条)');
  }

  // 注册控制台扩展
  ctx.inject(['console'], (ctx) => {
    ctx.console.addEntry({
      dev: path.resolve(__dirname, '../client/index.ts'),
      prod: path.resolve(__dirname, '../dist'),
    });

    // 获取记忆统计
    ctx.console.addListener('mio/memory-stats', async () => {
      if (!memory) {
        return {
          enabled: false,
          episodic: { active: 0, archived: 0 },
          relational: 0,
          semantic: 0,
        };
      }

      try {
        const episodicActive = await ctx.database.get('mio.episodic', { archived: false });
        const episodicArchived = await ctx.database.get('mio.episodic', { archived: true });
        const relational = await ctx.database.get('mio.relational', {});
        const semantic = await ctx.database.get('mio.semantic', {});

        return {
          enabled: true,
          episodic: {
            active: episodicActive.length,
            archived: episodicArchived.length,
          },
          relational: relational.length,
          semantic: semantic.length,
        };
      } catch (err) {
        logger.error('获取记忆统计失败:', err);
        throw err;
      }
    });

    // 手动触发蒸馏
    ctx.console.addListener('mio/trigger-distillation', async () => {
      if (!memory) {
        throw new Error('记忆系统未启用');
      }

      try {
        logger.info('手动触发蒸馏...');
        await memory.runDistillation();
        return '蒸馏完成！已更新关系印象和语义事实。';
      } catch (err) {
        logger.error('手动蒸馏失败:', err);
        throw err;
      }
    });

    // 立即写入 Working Memory
    ctx.console.addListener('mio/flush-memory', async () => {
      if (!memory) {
        throw new Error('记忆系统未启用');
      }

      try {
        logger.info('手动 flush Working Memory...');
        await memory.flushWorkingMemory();
        return 'Working Memory 已写入数据库！';
      } catch (err) {
        logger.error('手动 flush 失败:', err);
        throw err;
      }
    });

    // 迁移 participants 字段
    ctx.console.addListener('mio/migrate-participants', async () => {
      try {
        logger.info('开始迁移 participants 字段...');

        const BOT_USER_ID = 'bot';
        const BOT_IDENTIFIERS = ['澪', 'mio', '999', 'u999', 'bot'];

        // 获取所有 episodic 记录
        const allEpisodes = await ctx.database.get('mio.episodic', {});

        if (allEpisodes.length === 0) {
          return '没有需要迁移的记录';
        }

        logger.info(`找到 ${allEpisodes.length} 条记录`);

        let migratedCount = 0;
        let unchangedCount = 0;

        for (const episode of allEpisodes) {
          const originalParticipants = episode.participants || [];
          const cleanedParticipants: string[] = [];
          let hasChanges = false;

          for (const p of originalParticipants) {
            const original = String(p).trim();
            let cleaned = original;

            // 1. 检查是否是 bot 的各种表示
            if (BOT_IDENTIFIERS.includes(original.toLowerCase())) {
              cleaned = BOT_USER_ID;
              if (original !== BOT_USER_ID) {
                hasChanges = true;
                logger.debug(`[ep=${episode.id}] Bot: "${original}" -> "${cleaned}"`);
              }
            }
            // 2. 去除 u 前缀（如果是 u + 纯数字）
            else if (/^u\d+$/.test(original)) {
              cleaned = original.substring(1);
              hasChanges = true;
              logger.debug(`[ep=${episode.id}] User: "${original}" -> "${cleaned}"`);
            }
            // 3. 纯数字，保持不变
            else if (/^\d+$/.test(original)) {
              cleaned = original;
            }
            // 4. 其他情况（可能是昵称或错误数据），记录警告
            else {
              logger.warn(`[ep=${episode.id}] 未知格式的 participant: "${original}"`);
              cleaned = original; // 保持原样，后续人工检查
            }

            cleanedParticipants.push(cleaned);
          }

          // 去重
          const uniqueParticipants = [...new Set(cleanedParticipants)];

          if (hasChanges || uniqueParticipants.length !== originalParticipants.length) {
            await ctx.database.set(
              'mio.episodic',
              { id: episode.id },
              { participants: uniqueParticipants }
            );
            migratedCount++;

            if (uniqueParticipants.length !== originalParticipants.length) {
              logger.debug(
                `[ep=${episode.id}] 去重: ${originalParticipants.length} -> ${uniqueParticipants.length}`
              );
            }
          } else {
            unchangedCount++;
          }
        }

        // 验证结果
        const allEpisodesAfter = await ctx.database.get('mio.episodic', {});
        const stats = {
          total: allEpisodesAfter.length,
          withBot: 0,
          withUsers: 0,
          withUnknown: 0,
        };

        for (const episode of allEpisodesAfter) {
          const participants = episode.participants || [];
          for (const p of participants) {
            const str = String(p);
            if (str === BOT_USER_ID) {
              stats.withBot++;
            } else if (/^\d+$/.test(str)) {
              stats.withUsers++;
            } else {
              stats.withUnknown++;
            }
          }
        }

        const result = `迁移完成！
已更新: ${migratedCount} 条
无需更改: ${unchangedCount} 条

验证结果:
- 总记录数: ${stats.total}
- Bot 参与: ${stats.withBot} 次
- 用户参与: ${stats.withUsers} 次
- 未知格式: ${stats.withUnknown} 次`;

        logger.info(result);
        return result;
      } catch (err) {
        logger.error('迁移失败:', err);
        throw err;
      }
    });

    // Token 用量统计
    ctx.console.addListener('mio/token-stats', () => {
      return tokenTracker.getStats();
    });

    // 重置 Token 统计
    ctx.console.addListener('mio/token-stats-reset', async () => {
      await tokenTracker.reset();
      return '统计已重置';
    });
  });

  // 安全计数器
  const hourlyReplies = new Map<string, number>();

  // 每小时重置回复计数
  setInterval(() => hourlyReplies.clear(), 3600_000);

  // 机器人禁言状态（key: groupId）
  const botMutedGroups = new Map<string, boolean>();

  // 图片处理任务追踪
  interface ImageTask {
    messageId: string;
    promise: Promise<string | null>;
    startTime: number;
  }
  const pendingImageTasks = new Map<string, ImageTask[]>(); // groupId -> tasks[]

  // 活跃的 LLM 请求（用于取消）
  const activeRequests = new Map<string, AbortController>();

  // 每个群上一次成功回复的时间戳
  const lastRespondedAt = new Map<string, number>();

  // 记忆提取锁（防止重复触发）
  const extractionLocks = new Map<string, boolean>();

  /**
   * 触发记忆提取
   */
  async function triggerMemoryExtraction(groupId: string, reason: string): Promise<void> {
    if (!memory || !extractionScheduler) return;

    // 检查是否已经在提取中
    if (extractionLocks.get(groupId)) {
      logger.debug(`[${groupId}] 记忆提取已在进行中，跳过`);
      return;
    }

    const pendingCount = extractionScheduler.getPendingCount(groupId);
    if (pendingCount === 0) {
      logger.debug(`[${groupId}] 没有新消息需要提取`);
      return;
    }

    // 获取自上次提取以来的所有消息
    const cutoff = extractionScheduler.getLastExtractedAt(groupId);
    const messages = buffer.getRecent(groupId).filter(m => m.timestamp > cutoff);

    if (messages.length === 0) {
      logger.debug(`[${groupId}] buffer 中没有新消息（可能已被清理），重置计数器`);
      extractionScheduler.markExtracted(groupId);
      return;
    }

    logger.debug(`[${groupId}] 触发记忆提取 (${reason}, ${messages.length} 条消息, pending=${pendingCount})`);

    // 加锁
    extractionLocks.set(groupId, true);

    try {
      const summary = await memory.record({
        groupId,
        recentMessages: messages,
        botName: config.botName,
      });

      // 使用最后处理的消息时间戳，避免丢失提取期间到达的消息
      const lastProcessedTimestamp = messages[messages.length - 1].timestamp;
      extractionScheduler.markExtracted(groupId, lastProcessedTimestamp);

      if (summary.worthRemembering) {
        const parts = [
          `记忆提取完成: ${summary.episodes} 条记忆, ${summary.relational} 条关系, ${summary.vibes} 条情绪`,
          ...summary.episodeSummaries.map(s => `  ep: ${s}`),
          ...summary.relationalSummaries.map(s => `  rel: ${s}`),
          ...summary.sessionVibes.map(s => `  vibe: ${s}`),
        ];
        logger.debug(`[${groupId}] ${parts.join('\n')}`);
      } else {
        logger.debug(`[${groupId}] 记忆提取完成: 无值得记住的内容`);
      }
    } catch (err) {
      logger.warn(`[${groupId}] 记忆提取失败:`, err);
    } finally {
      // 解锁
      extractionLocks.delete(groupId);
    }
  }

  /**
   * 获取新消息（自上次成功回复以来的消息）
   */
  function getNewMessages(groupId: string): NormalizedMessage[] {
    const cutoff = lastRespondedAt.get(groupId) || 0;
    return buffer.getRecent(groupId)
      .filter(m => !m.isBot && m.timestamp > cutoff);
  }

  /**
   * 等待图片处理完成（支持 abort）
   */
  async function waitForPendingImages(groupId: string, signal: AbortSignal): Promise<void> {
    const imageTasks = pendingImageTasks.get(groupId) || [];
    if (imageTasks.length === 0) return;

    logger.debug(`[${groupId}] 等待 ${imageTasks.length} 个图片处理任务完成...`);

    const IMAGE_TIMEOUT = 12000; // 12 秒超时
    const results = await Promise.all(
      imageTasks.map(async (task) => {
        // 检查是否已被取消
        if (signal.aborted) return null;

        try {
          // 带超时的等待
          const result = await Promise.race([
            task.promise,
            new Promise<null>((resolve) =>
              setTimeout(() => resolve(null), IMAGE_TIMEOUT)
            ),
          ]);

          const elapsed = Date.now() - task.startTime;
          if (result === null && elapsed >= IMAGE_TIMEOUT) {
            logger.warn(`[${groupId}] 图片处理超时 (${elapsed}ms)`);
            return { messageId: task.messageId, description: '[图片：没看清]' };
          }

          return { messageId: task.messageId, description: result || '[图片]' };
        } catch (error) {
          logger.error(`[${groupId}] 图片处理异常:`, error);
          return { messageId: task.messageId, description: '[图片：没看清]' };
        }
      })
    );

    // 检查是否在等待过程中被取消
    if (signal.aborted) return;

    // 更新 buffer 中的消息内容
    const allMessages = buffer.getRecent(groupId);
    for (const result of results) {
      if (!result) continue;
      const msg = allMessages.find(m => m.id === result.messageId);
      if (msg && result.description) {
        // 替换 ImageSegment 的 description
        const imgSeg = msg.segments.find((s): s is import('./perception/types').ImageSegment => s.type === 'image' && !s.description);
        if (imgSeg) {
          imgSeg.description = result.description;
        }
        logger.debug(`[${groupId}] 更新消息 ${result.messageId} 图片描述: ${result.description}`);
      }
    }

    // 清空已处理的任务
    pendingImageTasks.delete(groupId);
  }

  logger.info("澪已启动");
  logger.info(`对话模型: ${config.models.chat.providerId}/${config.models.chat.modelName}`);
  if (config.vision.enabled) {
    logger.info(`图片理解模型: ${config.models.vision.providerId}/${config.models.vision.modelName}`);
  }
  logger.info(`Debounce: idle=${config.debounce.idleMs}ms / min=${config.debounce.minWaitMs}ms / max=${config.debounce.maxWaitMs}ms`);

  // 预加载历史消息到 buffer
  let historyLoaded = false;

  async function preloadHistoryMessages() {
    if (historyLoaded) return;
    historyLoaded = true;

    logger.info("开始预加载历史消息...");

    for (const groupId of config.enableGroups) {
      try {
        const bot = ctx.bots[0];
        if (!bot) {
          logger.warn(`[${groupId}] 没有可用的 bot`);
          continue;
        }

        const allMessages: any[] = [];
        let next: string | undefined = undefined;
        const maxIterations = 10; // 防止无限循环
        let iteration = 0;

        // 循环获取直到填满 buffer 或没有更多消息
        while (allMessages.length < config.bufferSize && iteration < maxIterations) {
          iteration++;

          const messageList = await bot.getMessageList(groupId, next, 'before', config.bufferSize);

          if (!messageList?.data || messageList.data.length === 0) {
            break;
          }

          allMessages.push(...messageList.data);

          if (messageList.next) {
            next = messageList.next;
          } else {
            break;
          }
        }

        if (allMessages.length === 0) {
          logger.info(`[${groupId}] 没有历史消息`);
          continue;
        }

        // 按时间顺序排序（从旧到新）
        const sortedMessages = allMessages.sort((a, b) =>
          (a.timestamp || 0) - (b.timestamp || 0)
        );

        // 取最近的消息填满 buffer
        const messagesToLoad = sortedMessages.slice(-config.bufferSize);

        // 填充到 buffer
        let latestTimestamp = 0;
        for (const msg of messagesToLoad) {
          // 构造伪 session 对象来复用 normalizer
          const fakeSession: any = {
            elements: msg.elements,
            content: msg.content,
            quote: msg.quote,
            event: { message: msg },
            selfId: bot.selfId,
            guildId: groupId,
            bot,
          };

          // 使用 normalizer 处理
          const normalizedMsg = await normalizer.normalize(fakeSession, true, buffer);
          const timestamp = normalizedMsg.timestamp;

          buffer.push(groupId, normalizedMsg);

          // 记录最新的时间戳
          if (timestamp > latestTimestamp) {
            latestTimestamp = timestamp;
          }
        }

        // 初始化 lastRespondedAt 为最新消息的时间戳
        // 这样预加载的历史消息不会被当成"新消息"
        lastRespondedAt.set(groupId, latestTimestamp);

        // 初始化提取调度器的时间戳
        if (extractionScheduler) {
          extractionScheduler.markExtracted(groupId);
        }

        const botMessageCount = messagesToLoad.filter(m => m.user?.id === bot.selfId).length;
        logger.info(`[${groupId}] 预加载了 ${messagesToLoad.length} 条历史消息（包含 bot 消息: ${botMessageCount} 条）`);
      } catch (error) {
        logger.warn(`[${groupId}] 预加载历史消息失败:`, error);
        historyLoaded = false; // 失败了允许重试
      }
    }

    logger.info("历史消息预加载完成");
  }

  // 冷启动：等 bot 上线后再预加载
  ctx.on('bot-status-updated', async (bot) => {
    if (bot.status !== Universal.Status.ONLINE) return;
    await preloadHistoryMessages();
  });

  // 热重载：如果 bot 已经在线，直接预加载
  ctx.on('ready', async () => {
    for (const bot of ctx.bots) {
      if (bot.status === Universal.Status.ONLINE) {
        await preloadHistoryMessages();
        break;
      }
    }

    // 启动记忆提取超时检查器
    if (extractionScheduler) {
      // 为所有启用的群初始化时间戳（避免启动时立即触发超时）
      for (const groupId of config.enableGroups) {
        if (extractionScheduler.getLastExtractedAt(groupId) === 0) {
          extractionScheduler.markExtracted(groupId);
          logger.debug(`[${groupId}] 初始化记忆提取时间戳`);
        }
      }

      extractionScheduler.startTimeoutChecker(config.enableGroups, async (groupId) => {
        logger.debug(`[${groupId}] 记忆提取超时触发`);
        await triggerMemoryExtraction(groupId, 'timeout');
      });
    }
  });

  function resolveNameFromBuffer(groupId: string, userId: string): string {
    const recent = buffer.getRecent(groupId);
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].senderId === userId) return recent[i].sender;
    }
    return userId;
  }

  // Reaction 事件处理
  ctx.on("internal/session", async (session) => {
    if (session.type !== 'notice' || session.subtype !== 'group-msg-emoji-like') return;

    const data = (session as any).onebot as {
      message_id?: string | number;
      user_id?: string | number;
      group_id?: string | number;
      likes?: Array<{ emoji_id: string; count: number }>;
    } | undefined;

    if (!data) return;

    const msgId = String(data.message_id ?? '');
    const userId = String(data.user_id ?? '');
    const likes = data.likes ?? [];

    logger.debug(`[reaction] msgId=${msgId} userId=${userId} likes=${JSON.stringify(likes)}`);

    for (const like of likes) {
      const emoji = getEmojiById(String(like.emoji_id));
      const emojiName = emoji?.name ?? `表情${like.emoji_id}`;
      const isAdd = like.count > 0;
      buffer.handleReaction(msgId, emojiName, userId, isAdd, session.selfId, like.count);
    }
  });

  ctx.on("internal/session", async (session) => {
    if (session.type !== 'guild-member' && session.subtype !== 'ban') return;

    const data = (session as any).onebot as {
      notice_type?: string;
      sub_type?: string;
      group_id?: string | number;
      user_id?: string | number;
      operator_id?: string | number;
      duration?: number;
    } | undefined;

    if (!data || data.notice_type !== 'group_ban') return;

    const groupId = String(data.group_id ?? '');
    if (!groupId || !config.enableGroups.includes(groupId)) return;

    const userId = String(data.user_id ?? '');
    const operatorId = String(data.operator_id ?? '');
    const duration = data.duration ?? 0;
    const isLift = data.sub_type === 'lift_ban';
    const isSelf = userId === session.selfId;

    const targetName = isSelf ? config.botName : resolveNameFromBuffer(groupId, userId);
    const operatorName = resolveNameFromBuffer(groupId, operatorId);

    let noticeText: string;
    if (isLift) {
      noticeText = `（${operatorName} 解除了 ${targetName} 的禁言）`;
    } else {
      const durationMin = Math.round(duration / 60);
      noticeText = durationMin > 0
        ? `（${operatorName} 将 ${targetName} 禁言了 ${durationMin} 分钟）`
        : `（${operatorName} 将 ${targetName} 禁言了）`;
    }

    buffer.push(groupId, {
      id: crypto.randomUUID(),
      sender: '系统',
      senderId: 'system',
      isBot: false,
      isSystemEvent: true,
      timestamp: Date.now(),
      segments: [{ type: 'notice', content: noticeText }],
      mentions: [],
    });

    logger.debug(`[${groupId}] 禁言通知: ${noticeText}`);

    // 更新机器人禁言状态
    if (isSelf) {
      if (isLift) {
        botMutedGroups.delete(groupId);
        logger.info(`[${groupId}] 机器人禁言已解除`);
      } else {
        botMutedGroups.set(groupId, true);
        logger.info(`[${groupId}] 机器人已被禁言`);
      }
    }
  });

  ctx.on("message-deleted", async (session) => {
    const groupId = session.event?.channel?.id || session.guildId;
    if (!groupId || !config.enableGroups.includes(groupId)) return;

    const recalledMsgId = session.messageId;
    if (!recalledMsgId) return;

    // 查找撤回者名称（优先用 buffer 中的操作者信息）
    const recalledByName = session.event?.member?.nick
      || session.author?.nick
      || session.author?.name
      || session.username
      || session.userId
      || '某人';

    const notice = normalizer.handleRecall(recalledMsgId, recalledByName, buffer);
    if (notice) {
      buffer.push(groupId, notice);
      logger.debug(`[${groupId}] 撤回通知已记录: ${recalledMsgId}`);
    }
  });

  ctx.on("message", async (session) => {
    // 只处理群消息
    if (session.event.channel?.type !== 0) return;
    const groupId = session.event.channel?.id;
    if (!groupId || !config.enableGroups.includes(groupId)) return;
    // 立即提取消息
    const msg = await normalizer.normalize(session, false, buffer);
    const messageId = msg.id;

    // 检查是否有图片，如果有则异步启动处理（不阻塞）
    let imageTaskPromise: Promise<string | null> | null = null;
    if (imageProcessor && session.elements?.some(el => el.type === 'img' || el.type === 'image')) {
      // 提取图片并异步处理
      const images = imageProcessor.extractImages(session);
      if (images.length > 0) {
        // 获取上下文消息（前后各 2 条）
        const recentMessages = buffer.getRecent(groupId, 5); // 最近 5 条
        imageTaskPromise = Promise.all(
          images.map(async (img) => {
            const analysis = await imageProcessor.analyzeImage(img.url);
            logger.debug(`[sticker] VLM决策: type=${analysis.type} collect=${analysis.collect ?? false} | "${analysis.description.slice(0, 40)}"`)
            if (analysis.type === 'sticker' && analysis.collect) {
              logger.debug(`[sticker] 收藏元数据: vibe="${analysis.sticker_vibe}" style="${analysis.sticker_style}" scene="${analysis.sticker_scene}"`)
            }
            // Fire-and-forget sticker collection
            if (stickerService && analysis.type === 'sticker' && analysis.collect) {
              imageProcessor.downloadBuffer(img.url).then(buf => {
                if (buf) {
                  stickerService!.maybeCollect(img.url, buf, analysis, msg.sender)
                    .catch(err => logger.warn('[sticker] 收集失败:', err));
                }
              }).catch(err => logger.warn('[sticker] 图片下载失败:', err));
            }
            return analysis.description;
          })
        ).then(descriptions => {
          // 只返回第一张图片的纯描述（ImageSegment.description 应存纯文本，由 renderer 负责格式化）
          const description = descriptions[0] || null;
          logger.debug(`[${groupId}] 图片处理完成: ${description}`);
          return description;
        }).catch(err => {
          logger.error(`[${groupId}] 图片处理失败:`, err);
          return null;
        });

        // 记录到待处理任务
        if (!pendingImageTasks.has(groupId)) {
          pendingImageTasks.set(groupId, []);
        }
        pendingImageTasks.get(groupId)!.push({
          messageId,
          promise: imageTaskPromise,
          startTime: Date.now(),
        });
      }
    }

    // 此时 msg 已经是 NormalizedMessage，不再需要拼装 BufferedMessage 了
    buffer.push(groupId, msg);

    // 检查是否应该触发记忆提取
    if (extractionScheduler) {
      const decision = extractionScheduler.onNewMessage(groupId, msg.isBot);
      logger.debug(`[${groupId}] 记忆提取待处理: ${decision.pendingCount} 条消息`);
      if (decision.shouldExtract) {
        // Fire-and-forget，不阻塞消息处理
        triggerMemoryExtraction(groupId, decision.reason!).catch(err => {
          logger.warn(`[${groupId}] 记忆提取失败:`, err);
        });
      }
    }

    // 粗筛：跳过 bot 自己的消息
    if (msg.isBot) return;

    // 检查是否被显式触发（@ 或回复 bot 的消息）
    const renderedText = renderer.renderContent(msg);
    const mentionsBot = isMentioningBot(renderedText, config);
    const repliesToBot = !!(msg.replyTo && buffer.findById(msg.replyTo.messageId)?.isBot);
    const engaged = mentionsBot || repliesToBot;

    // Debounce 触发
    debouncer.onMessage(groupId, msg, engaged, async () => {
      await processConversation(groupId, session, engaged);
    });
  });

  /**
   * 从 buffer 中构建去重的用户列表快照（用于 @ 后处理）
   */
  function buildUsersSnapshot(groupId: string): UserInfo[] {
    const users: UserInfo[] = [];
    const seenIds = new Set<string>();
    for (const m of buffer.getRecent(groupId)) {
      if (!m.isBot && !seenIds.has(m.senderId)) {
        seenIds.add(m.senderId);
        users.push({ name: m.sender, id: m.senderId });
      }
    }
    return users;
  }

  /**
   * 创建一条 bot 发出的 NormalizedMessage 并推入 buffer
   */
  function pushBotMessage(groupId: string, selfId: string, content: string, segmentType: 'text' | 'notice' = 'text'): void {
    buffer.push(groupId, {
      id: crypto.randomUUID(),
      sender: config.botName,
      senderId: selfId,
      isBot: true,
      timestamp: Date.now(),
      segments: [{ type: segmentType, content }],
      mentions: [],
      ...(segmentType === 'text' ? { rawContent: content } : {}),
    });
  }

  /**
   * 执行 LLM 返回的 actions 列表，返回是否发送了消息（用于计数）
   */
  async function executeActions(
    actions: Action[],
    msgMap: Map<string, NormalizedMessage>,
    groupId: string,
    session: Session,
    signal: AbortSignal,
  ): Promise<boolean> {
    const usersSnapshot = buildUsersSnapshot(groupId);
    let hasSentMessage = false;

    for (const action of actions) {
      if (signal.aborted) break;

      if (action.type === 'message') {
        if (!action.content.trim()) continue;

        const processed = resolveAtMentions(action.content, usersSnapshot)
          .replace(/@#(\d+)/g, '<at id="$1"/>');
        await humanizedSend(session, processed);
        pushBotMessage(groupId, session.selfId, action.content);
        hasSentMessage = true;

      } else if (action.type === 'reply') {
        const realMsg = msgMap.get(action.target_msg_id);
        if (!realMsg) {
          logger.warn(`[${groupId}] reply 目标消息不存在: ${action.target_msg_id}`);
          continue;
        }
        if (!action.text?.trim()) continue;

        const processed = resolveAtMentions(action.text, usersSnapshot)
          .replace(/@#(\d+)/g, '<at id="$1"/>');
        await humanizedSend(session, `<quote id="${realMsg.id}"/>${processed}`);
        pushBotMessage(groupId, session.selfId, action.text);
        hasSentMessage = true;

      } else if (action.type === 'react') {
        const realMsg = msgMap.get(action.target_msg_id);
        if (!realMsg) {
          logger.warn(`[${groupId}] react 目标消息不存在: ${action.target_msg_id}`);
          continue;
        }

        const emoji = findEmoji(action.emoji_name);
        if (!emoji) {
          logger.warn(`[${groupId}] 未找到表情: ${action.emoji_name}`);
          continue;
        }

        try {
          const bot = session.bot as OneBotBot<any>;
          await bot.internal.setMsgEmojiLike(realMsg.id, emoji.id);
          buffer.handleReaction(realMsg.id, emoji.name, session.selfId, true, session.selfId);
          logger.debug(`[${groupId}] 对消息 ${action.target_msg_id} 发送表情: ${emoji.name}`);
        } catch (err) {
          logger.warn(`[${groupId}] 发送表情失败:`, err);
        }

      } else if (action.type === 'sticker') {
        if (!stickerService) {
          logger.debug('[sticker] 表情包服务未启用，跳过');
          continue;
        }
        try {
          const sticker = await stickerService.resolveSticker(action.intent);
          if (!sticker) {
            logger.debug(`[sticker] 没找到匹配的表情包 (intent: ${action.intent})`);
            continue;
          }
          const imgBuf = fs.readFileSync(sticker.imagePath);
          if (imgBuf.length > 2 * 1024 * 1024) {
            logger.warn(`[sticker] 文件过大 (${(imgBuf.length / 1024 / 1024).toFixed(1)} MB)，跳过发送: ${path.basename(sticker.imagePath)}`);
            continue;
          }
          await session.send(h.image(imgBuf, stickerMimeType(sticker.imagePath)));
          hasSentMessage = true;
          logger.debug(`[sticker] 发送表情包: ${path.basename(sticker.imagePath)}`);
          pushBotMessage(groupId, session.selfId, `（发了张表情包——本来想找「${action.intent}」，找到了「${sticker.description}」）`, 'notice');
        } catch (err) {
          logger.warn('[sticker] 发送表情包失败:', err);
        }

      } else if (action.type === 'recall') {
        const realMsg = msgMap.get(action.target_msg_id);
        if (!realMsg) {
          logger.warn(`[${groupId}] recall 目标消息不存在: ${action.target_msg_id}`);
          continue;
        }
        if (!realMsg.isBot) {
          logger.warn(`[${groupId}] recall 目标消息不是 bot 消息: ${action.target_msg_id}`);
          continue;
        }

        try {
          await session.bot.deleteMessage(session.channelId, realMsg.id);
          buffer.markRecalled(realMsg.id);
          logger.debug(`[${groupId}] 撤回消息: ${action.target_msg_id}`);
        } catch (err) {
          logger.warn(`[${groupId}] 撤回失败:`, err);
        }

      } else {
        logger.warn(`未知的 action 类型: ${(action as any).type}`);
      }
    }

    return hasSentMessage;
  }

  /**
   * 处理搜索请求
   */
  async function handleSearch(
    searchRequest: SearchRequest,
    originalNewMessages: NormalizedMessage[],
    groupId: string,
    session: Session,
    signal: AbortSignal
  ): Promise<void> {
    if (!searchService) {
      logger.warn("搜索服务未启用，跳过搜索");
      return;
    }

    try {
      // 1. Execute search
      logger.debug(`[${groupId}] 执行搜索: ${searchRequest.query} (hint: ${searchRequest.hint})`);
      const searchInjection = await searchService.search(searchRequest);
      logger.debug(`[${groupId}] 搜索结果: ${searchInjection}`);

      // 2. Build followup prompt
      const newMessagesText = originalNewMessages
        .map(m => renderer.renderMessage(m))
        .join('\n');

      const fiveMinAgoSearch = Date.now() - 5 * 60_000;
      const recentBotCountSearch = buffer.getRecent(groupId)
        .filter(m => m.isBot && m.timestamp > fiveMinAgoSearch).length;
      const recentBotActivitySearch = recentBotCountSearch > 0
        ? `（你最近 5 分钟内说了 ${recentBotCountSearch} 条消息。）\n`
        : '';

      const promptManager = getPromptManager();
      const followupPrompt = promptManager.get('search_followup_prompt', {
        newMessages: newMessagesText,
        searchInjection: searchInjection,
        recentBotActivity: recentBotActivitySearch,
      });

      // 3. Build system prompt (reuse from original context)
      const allMessagesForSearch = buffer.getRecent(groupId);
      const newMessageIdsForSearch = new Set(originalNewMessages.map(m => m.id));
      const { text: recentMessagesFormatted, msgMap: searchMsgMap } = renderer.render(allMessagesForSearch, newMessageIdsForSearch);

      // Get memory context if available
      let memoryUserProfile = '';
      let memoryMemories = '';

      if (memory) {
        try {
          const participantIds = [...new Set(originalNewMessages.map(m => m.senderId))];
          const allBuffered = buffer.getRecent(groupId);
          const memCtx = await memory.getMemoryContext(groupId, participantIds, originalNewMessages, allBuffered);
          if (memCtx.userProfile) memoryUserProfile = memCtx.userProfile;
          if (memCtx.memories) memoryMemories = memCtx.memories;
        } catch (err) {
          logger.warn('获取记忆上下文失败:', err);
        }
      }

      const systemPrompt = promptBuilder.buildSystemPrompt({
        groupId,
        userId: session.userId,
        recentMessages: recentMessagesFormatted,
        userProfile: memoryUserProfile,
        memories: memoryMemories,
        stickerSummary: stickerService?.getSummary() || undefined,
      });

      // 4. Second LLM call
      logger.debug(`[${groupId}] 搜索后调用 LLM...`);
      const response = await llm.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: followupPrompt },
        ],
        config.models.chat,
        { signal }
      );

      logger.info(
        `[${groupId}] 搜索后 LLM 响应: ${response.content} (tokens: ${response.usage.promptTokens}+${response.usage.completionTokens})`,
      );

      // 5. Parse and validate (search must be null)
      let parsedResponse: LLMResponse;

      try {
        const jsonMatch = response.content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          logger.warn("搜索后 LLM 输出不包含 JSON，跳过");
          return;
        }
        parsedResponse = JSON.parse(jsonMatch[0]);
      } catch (error) {
        logger.error("解析搜索后 LLM JSON 输出失败:", error);
        return;
      }

      // Validate: search must be null
      if (parsedResponse.search) {
        logger.warn("搜索后 LLM 仍返回 search 请求，视为 silent");
        return;
      }

      // 如果请求已被新的 @ 触发取消，跳过执行（新的 processConversation 会处理）
      if (signal.aborted) {
        logger.debug(`[${groupId}] 搜索后请求已被取消，跳过 action 执行`);
        return;
      }

      // 6. Execute actions if not silent
      if (!parsedResponse.silent && parsedResponse.actions && parsedResponse.actions.length > 0) {
        const hasSent = await executeActions(parsedResponse.actions, searchMsgMap, groupId, session, signal);
        if (hasSent) {
          debouncer.markSpoke(groupId);
          const hourCount = hourlyReplies.get(groupId) || 0;
          hourlyReplies.set(groupId, hourCount + 1);
        }
      }

      // 推进指针（LLM 完成决策即推进，silent/react-only 也算）
      if (originalNewMessages.length > 0) {
        lastRespondedAt.set(groupId, originalNewMessages[originalNewMessages.length - 1].timestamp);
      }
    } catch (error) {
      logger.error(`[${groupId}] 搜索处理失败:`, error);
    }
  }

  /**
   * 处理对话（Debounce 触发后）
   */
  async function processConversation(groupId: string, session: Session, isMentioned: boolean = false) {
    // 如果是被 @，且有旧请求在飞 → 取消它
    if (isMentioned) {
      const existing = activeRequests.get(groupId);
      if (existing) {
        existing.abort();
        logger.debug(`[${groupId}] 被 @ 触发，取消旧请求`);
      }
    } else {
      // 普通 debounce 触发：如果有请求在飞就跳过
      if (activeRequests.has(groupId)) {
        logger.debug(`[${groupId}] 已有请求在处理，跳过本次触发`);
        return;
      }
    }

    const controller = new AbortController();
    activeRequests.set(groupId, controller);

    let newMessages: NormalizedMessage[] = [];

    try {
      // 安全检查：每小时回复次数
      const hourCount = hourlyReplies.get(groupId) || 0;
      if (hourCount >= config.safety.maxReplyPerHour) {
        logger.debug(`[${groupId}] 达到每小时回复上限`);
        return;
      }

      // 安全检查：连续回复次数
      const recent = buffer.getRecent(groupId, config.safety.maxConsecutiveReplies + 1);
      const consecutiveBotReplies = countTrailingBotMessages(recent);
      if (consecutiveBotReplies >= config.safety.maxConsecutiveReplies) {
        logger.debug(`[${groupId}] 连续回复过多，静默`);
        return;
      }

      // 安全检查：最小冷却时间
      const lastReply = buffer.getLastBotReply(groupId);
      if (lastReply && Date.now() - lastReply.timestamp < config.safety.minCooldownMs) {
        logger.debug(`[${groupId}] 冷却中`);
        return;
      }

      // 安全检查：机器人被禁言时跳过 LLM
      if (botMutedGroups.get(groupId)) {
        logger.debug(`[${groupId}] 机器人被禁言中，跳过 LLM 请求`);
        return;
      }

      // 等待图片处理完成
      await waitForPendingImages(groupId, controller.signal);

      // 检查是否已被取消
      if (controller.signal.aborted) {
        logger.debug(`[${groupId}] 请求已被取消（等待图片时）`);
        return;
      }

      // 获取新消息（基于上次成功回复的时间）
      newMessages = getNewMessages(groupId);

      if (newMessages.length === 0) {
        logger.debug(`[${groupId}] 没有新消息，跳过`);
        return;
      }

      // 格式化新消息作为标记
      const newMessageMarker = newMessages
        .map(msg => renderer.renderMessage(msg))
        .join('\n');

      // 构建 prompt（使用最新的 buffer 内容）
      // 记忆系统：读取路径
      let memoryUserProfile: string | undefined;
      let memoryMemories: string | undefined;
      if (memory) {
        try {
          const participantIds = [...new Set(newMessages.map(m => m.senderId))];
          const allBuffered = buffer.getRecent(groupId);
          const memCtx = await memory.getMemoryContext(groupId, participantIds, newMessages, allBuffered);
          if (memCtx.userProfile) memoryUserProfile = memCtx.userProfile;
          if (memCtx.memories) memoryMemories = memCtx.memories;
        } catch (err) {
          logger.warn('记忆读取失败:', err);
        }
      }

      const allMessages = buffer.getRecent(groupId);
      const newMessageIds = new Set(newMessages.map(m => m.id));
      const { text: recentMessagesText, msgMap } = renderer.render(allMessages, newMessageIds);
      const currentStickerSummary = stickerService?.getSummary() || undefined;
      const systemPrompt = promptBuilder.buildSystemPrompt({
        groupId,
        userId: session.userId,
        recentMessages: recentMessagesText,
        userProfile: memoryUserProfile,
        memories: memoryMemories,
        stickerSummary: currentStickerSummary,
        // Phase 3+ 扩展点：
        // recentSummary: await memory.getRecentSummary(groupId),
        // backgroundKnowledge: await search.augment(recent),
      });

      const fiveMinAgo = Date.now() - 5 * 60_000;
      const recentBotCount = buffer.getRecent(groupId)
        .filter(m => m.isBot && m.timestamp > fiveMinAgo).length;
      const userPrompt = promptBuilder.buildUserPrompt(newMessageMarker, recentBotCount);

      // Debug: 打印注入的记忆上下文
      if (memoryUserProfile || memoryMemories || currentStickerSummary) {
        logger.debug(`[${groupId}] === 记忆注入摘要 ===`
          + (memoryUserProfile ? `\n[userProfile]\n${memoryUserProfile}` : '')
          + (memoryMemories ? `\n[memories]\n${memoryMemories}` : '')
          + (currentStickerSummary ? `\n[stickerSummary]\n${currentStickerSummary}` : '')
        );
      }

      // 打印新消息（调用 LLM 前）
      logger.debug(`[${groupId}] 本轮新消息 (${newMessages.length} 条):\n${newMessageMarker}`);

      // 调用 LLM（传入 signal 和 JSON mode）
      logger.debug("调用 LLM...");
      const response = await llm.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        config.models.chat,
        {
          signal: controller.signal,
          responseFormat: 'json_object'
        }
      );

      // 再次检查是否被取消（LLM 已返回，但有新消息打断）
      // 推进指针，避免下一轮把当前批次重复列为新消息
      if (controller.signal.aborted) {
        logger.debug(`[${groupId}] 请求已被取消（LLM 返回后）`);
        return;
      }

      logger.info(
        `LLM 响应: ${response.content} (tokens: ${response.usage.promptTokens}+${response.usage.completionTokens})`,
      );

      // 解析 JSON 输出
      let parsedResponse: LLMResponse;
      try {
        const jsonMatch = response.content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          logger.warn("LLM 输出不包含 JSON，跳过");
          return;
        }
        parsedResponse = JSON.parse(jsonMatch[0]);
      } catch (error) {
        logger.error("解析 LLM JSON 输出失败:", error);
        logger.debug("原始输出:", response.content);
        return;
      }

      // 验证响应格式
      validateResponse(parsedResponse, logger);

      // 记录思考过程（调试用）
      logger.debug(`思考: ${parsedResponse.thought}`);
      logger.debug(`搜索: ${parsedResponse.search ? JSON.stringify(parsedResponse.search) : 'null'}`);
      logger.debug(`沉默: ${parsedResponse.silent}`);

      // Priority 1: Search takes priority
      if (parsedResponse.search) {
        logger.debug("LLM 请求搜索，执行搜索流程");
        await handleSearch(parsedResponse.search, newMessages, groupId, session, controller.signal);
        return;
      }

      // Priority 2: Silent check
      if (parsedResponse.silent) {
        logger.debug("LLM 选择沉默，不发送消息");
        // 沉默时：推进指针到最后一条新消息的时间戳（而不是当前时间）
        // 这样可以避免漏掉处理期间到达的消息
        if (newMessages.length > 0) {
          const lastNewMessageTime = newMessages[newMessages.length - 1].timestamp;
          lastRespondedAt.set(groupId, lastNewMessageTime);
          logger.debug(`[${groupId}] 推进指针到最后一条新消息: ${new Date(lastNewMessageTime).toLocaleTimeString()}`);
        }

        return;
      }

      // Priority 3: Execute actions
      if (!parsedResponse.actions || parsedResponse.actions.length === 0) {
        logger.warn("LLM 返回 silent=false 但 actions 为空，跳过");
        return;
      }

      const hasSentMessage = await executeActions(parsedResponse.actions, msgMap, groupId, session, controller.signal);

      // 更新回复计数 + 标记发言时间（仅 speak/reply 算回复）
      if (hasSentMessage) {
        debouncer.markSpoke(groupId);
        hourlyReplies.set(groupId, hourCount + 1);
      }

      // 推进指针（LLM 完成决策即推进，react-only 也算）
      lastRespondedAt.set(groupId, newMessages[newMessages.length - 1].timestamp);
    } catch (error) {
      if (error.name === 'AbortError') {
        // 被取消了，正常流程，不需要报错
        logger.debug(`[${groupId}] 请求被取消`);
        return;
      }
      logger.error("处理消息时出错:", error);
      // 非 abort 错误：推进指针，避免同一批消息无限重试
      if (newMessages && newMessages.length > 0) {
        lastRespondedAt.set(groupId, newMessages[newMessages.length - 1].timestamp);
        logger.debug(`[${groupId}] 出错后推进指针，避免重试风暴`);
      }
    } finally {
      // 只清理自己的 controller（可能已经被新请求覆盖了）
      if (activeRequests.get(groupId) === controller) {
        activeRequests.delete(groupId);
      }

      // 被 abort 的请求不做兜底——新请求会自己处理
      if (controller.signal.aborted) return;

      // 关键：检查处理期间有没有新消息漏掉了
      const unhandled = getNewMessages(groupId);
      if (unhandled.length > 0) {
        logger.debug(`[${groupId}] 处理期间有 ${unhandled.length} 条新消息，重新启动 debounce`);
        // 重新启动 debounce，让它等一个停顿周期再触发
        debouncer.restart(groupId, async () => {
          await processConversation(groupId, session, false);
        });
      }
    }
  }

  // 插件卸载时清理
  ctx.on("dispose", () => {
    debouncer.dispose();
    if (memory) memory.dispose();
    if (extractionScheduler) extractionScheduler.dispose();
  });
}

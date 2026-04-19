import * as path from "path";
import { Context } from "koishi";
import { } from "@koishijs/plugin-console";
import { } from "@wittf/koishi-plugin-adapter-onebot";
import { MessageBuffer } from "./pipeline/message-buffer";
import { Debouncer } from "./pipeline/debouncer";
import { LLMClient } from "./llm/client";
import { ProviderManager } from "./llm/provider";
import { PromptBuilder } from "./context/prompt-builder";
import { ImageProcessor } from "./pipeline/image-processor";
import { MessageNormalizer } from "./perception/normalizer";
import { ContextRenderer } from "./perception/renderer";
import { MemoryService } from "./memory";
import { MemoryExtractionScheduler } from "./memory/extraction-scheduler";
import { SearchService } from "./search/router";
import { StickerService } from "./sticker";
import { extendTokenTable, tokenTracker, TokenStats } from "./llm/token-tracker";
import { registerConsoleListeners } from "./console-listeners";
import { reloadPrompts } from "./memory/prompt-manager";
import { ShadowLogger } from "./shadow-logger";
import { Config } from "./config";
import type { Config as MioConfig } from "./config";
import { createRuntimeState } from "./runtime/state";
import { createConversationRuntime } from "./runtime/conversation";
import { registerHistoryAndReadyHandlers } from "./runtime/history";
import { registerRuntimeEvents } from "./runtime/events";
import { registerAdminCommands } from "./runtime/commands";
import { extendPersonaTables } from "./persona/types";
import { PersonaService, seedDefaultPersonaIfMissing } from "./persona/service";

declare module "@koishijs/plugin-console" {
  interface Events {
    "mio/memory-stats"(): Promise<{
      enabled: boolean;
      episodic: { active: number; archived: number };
      relational: number;
      semantic: number;
    }>;
    "mio/trigger-distillation"(): Promise<string>;
    "mio/flush-memory"(): Promise<string>;
    "mio/migrate-participants"(): Promise<string>;
    "mio/token-stats"(): Promise<TokenStats>;
    "mio/token-stats-reset"(): Promise<string>;
  }
}

export const name = "mio";
export const inject = ["database"];
export { Config };

export function apply(ctx: Context, config: MioConfig) {
  const logger = ctx.logger("mio");
  reloadPrompts();
  extendPersonaTables(ctx);

  if (!config?.providers || config.providers.length === 0) {
    logger.warn("未配置任何 LLM 供应商，插件将不会工作");
    return;
  }

  const invalidProviders = config.providers.filter((p) => !p.apiKey);
  if (invalidProviders.length > 0) {
    logger.warn(`以下供应商缺少 API Key: ${invalidProviders.map((p) => p.id).join(", ")}`);
    return;
  }

  const providerManager = new ProviderManager(config.providers);
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
  const personaService = new PersonaService(ctx, {
    defaultPersonaSeedFile: config.personaFile,
  });
  const personaSeedPromise = seedDefaultPersonaIfMissing(personaService).catch((error) => {
    logger.error("默认人设初始化失败:", error);
    return null;
  });
  const promptBuilder = new PromptBuilder(config.personaFile);
  logger.info(`人设文件已加载: ${config.personaFile} (${promptBuilder.getPersonaLength()} chars, 首行: "${promptBuilder.getPersonaPreview()}")`);

  extendTokenTable(ctx);
  tokenTracker.init(ctx);
  const tokenFlushInterval = setInterval(() => tokenTracker.flush(), 60_000);
  ctx.on("dispose", async () => {
    clearInterval(tokenFlushInterval);
    await tokenTracker.flush();
  });

  const imageProcessor = config.vision.enabled ? new ImageProcessor(llm, config.models.vision) : null;
  const normalizer = new MessageNormalizer(imageProcessor, config.botName);
  const renderer = new ContextRenderer();

  let memory: MemoryService | null = null;
  if (config.memory?.enabled) {
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

  let searchService: SearchService | null = null;
  if (config.search?.enabled) {
    if (!providerManager.hasProvider(config.search.compression.providerId)) {
      logger.warn(`搜索压缩供应商不存在: ${config.search.compression.providerId}，搜索功能已禁用`);
    } else {
      searchService = new SearchService(llm, {
        searxngBaseUrl: config.search.searxngBaseUrl,
        bangumiUserAgent: config.search.bangumiUserAgent,
        saucenaoApiKey: config.search.saucenaoApiKey,
        searchTimeoutMs: config.search.searchTimeoutMs,
        compressionModel: config.search.compression,
      });
      logger.info(`搜索增强已启用 (compression: ${config.search.compression.providerId}/${config.search.compression.modelName})`);
    }
  }

  let stickerService: StickerService | null = null;
  if (config.sticker?.enabled && memory) {
    stickerService = new StickerService(ctx, memory.getEmbeddingService(), {
      enabled: true,
      imageDir: config.sticker.imageDir,
      maxPoolSize: config.sticker.poolSize,
    });
    memory.setStickerService(stickerService);
    logger.info("表情包系统已启用");

    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    const weeklyTimer = setInterval(async () => {
      await stickerService!.runWeeklyDedup();
      logger.info("表情包周去重完成");
    }, WEEK_MS);
    ctx.on("dispose", () => clearInterval(weeklyTimer));
  }

  let extractionScheduler: MemoryExtractionScheduler | null = null;
  if (memory) {
    extractionScheduler = new MemoryExtractionScheduler({
      minMessages: 30,
      maxWaitMinutes: 15,
      activeThreshold: 8,
    });
    logger.info("记忆提取调度器已启用 (batch: 30 条, timeout: 15 分钟, active: 8 条)");
  }

  registerConsoleListeners(ctx, logger, memory);

  const state = createRuntimeState();
  const hourlyTimer = setInterval(() => state.hourlyReplies.clear(), 3600_000);

  const shadowLogger = config.shadowGroups.length > 0
    ? new ShadowLogger(path.resolve(ctx.baseDir, "data/shadow"))
    : null;

  const runtimeDeps = {
    ctx,
    config,
    logger,
    buffer,
    debouncer,
    llm,
    promptBuilder,
    imageProcessor,
    normalizer,
    renderer,
    memory,
    extractionScheduler,
    searchService,
    stickerService,
    shadowLogger,
  };

  const { processConversation, triggerMemoryExtraction } = createConversationRuntime(runtimeDeps, state);
  registerAdminCommands(runtimeDeps, state);
  registerHistoryAndReadyHandlers(runtimeDeps, state, triggerMemoryExtraction);
  registerRuntimeEvents(runtimeDeps, state, processConversation, triggerMemoryExtraction);

  logger.info("澪已启动");
  logger.info(`对话模型: ${config.models.chat.providerId}/${config.models.chat.modelName}`);
  if (config.vision.enabled) {
    logger.info(`图片理解模型: ${config.models.vision.providerId}/${config.models.vision.modelName}`);
  }
  logger.info(`Debounce: idle=${config.debounce.idleMs}ms / min=${config.debounce.minWaitMs}ms / max=${config.debounce.maxWaitMs}ms`);

  ctx.on("dispose", async () => {
    clearInterval(hourlyTimer);
    debouncer.dispose();
    await Promise.allSettled([personaSeedPromise]);

    // Flush pending memory before shutdown
    if (memory && extractionScheduler) {
      const pending = config.enableGroups.filter((g) => extractionScheduler!.getPendingCount(g) > 0);
      if (pending.length > 0) {
        logger.info(`Dispose: 正在提取 ${pending.length} 个群的待处理记忆...`);
        await Promise.allSettled(pending.map((g) => triggerMemoryExtraction(g, "shutdown")));
        logger.info("Dispose: 记忆提取完成");
      }
    }

    if (memory) await memory.dispose();
    if (extractionScheduler) extractionScheduler.dispose();
    if (searchService) searchService.dispose();
  });
}

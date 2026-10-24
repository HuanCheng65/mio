import * as path from "path";
import { Context } from "koishi";
import { Config as MioConfig } from "./config";
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
import { extendTokenTable, tokenTracker } from "./llm/token-tracker";
import { ShadowLogger } from "./shadow-logger";
import { createRuntimeState } from "./runtime/state";
import { createConversationRuntime } from "./runtime/conversation";
import { registerHistoryAndReadyHandlers } from "./runtime/history";
import { registerRuntimeEvents } from "./runtime/events";
import { registerAdminCommands } from "./runtime/commands";
import { PersonaService, seedDefaultPersonaIfMissing } from "./persona/service";
import { GeminiCacheManager } from "./llm/gemini-cache";
import { registerServiceListeners } from "./console/service-listeners";
import type { GroupRegistry } from "./runtime/groups";

type Logger = ReturnType<Context["logger"]>;

export function tryBootstrapServices(ctx: Context, config: MioConfig, logger: Logger, groups: GroupRegistry): boolean {
  if (!config?.providers || config.providers.length === 0) {
    logger.warn("未配置任何 LLM 供应商，运行时未启动（可在 Console 「模型配置」补全）");
    return false;
  }

  const invalidProviders = config.providers.filter((p) => !p.apiKey);
  if (invalidProviders.length > 0) {
    logger.warn(`以下供应商缺少 API Key: ${invalidProviders.map((p) => p.id).join(", ")}`);
    return false;
  }

  const providerManager = new ProviderManager(config.providers);
  if (!providerManager.hasProvider(config.models.chat.providerId)) {
    logger.warn(`对话模型引用的供应商不存在: ${config.models.chat.providerId}`);
    return false;
  }
  if (config.vision.enabled && !providerManager.hasProvider(config.models.vision.providerId)) {
    logger.warn(`图片理解模型引用的供应商不存在: ${config.models.vision.providerId}`);
    return false;
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
  const chatProvider = providerManager.getProviderConfig(config.models.chat.providerId);
  const geminiCacheManager = chatProvider?.type === "gemini"
    ? new GeminiCacheManager(ctx, providerManager.getGeminiProvider(config.models.chat.providerId))
    : null;
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

  registerServiceListeners(ctx, logger, memory, personaService, geminiCacheManager);

  const state = createRuntimeState();
  const hourlyTimer = setInterval(() => state.hourlyReplies.clear(), 3600_000);

  const shadowLogger = new ShadowLogger(path.resolve(ctx.baseDir, "data/shadow"));

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
    personaService,
    geminiCacheManager,
    groups,
  };

  const { processConversation, triggerMemoryExtraction } = createConversationRuntime(runtimeDeps, state);
  registerHistoryAndReadyHandlers(runtimeDeps, state, triggerMemoryExtraction);
  registerAdminCommands(runtimeDeps, state);
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

    if (memory && extractionScheduler) {
      const pending = groups.legacyGroups().filter((g) => extractionScheduler!.getPendingCount(g) > 0);
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

  return true;
}

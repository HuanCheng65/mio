import { Context } from "koishi";
import type { Config as MioConfig } from "../config";
import { LLMClient } from "../llm/client";
import { ProviderManager } from "../llm/provider";
import { EmbeddingService, verifyEmbeddingModel } from "../memory/embedding";
import type { NormalizedMessage } from "../perception/types";
import { Debouncer } from "../pipeline/debouncer";
import type { GroupRegistry } from "../runtime/groups";
import { SearchService } from "../search/router";
import type { AliasRegistry } from "./aliases";
import type { EventStore } from "./event-store";
import { createFindSourceTool, createSearchTool } from "./inward-tools";
import { AgentLLM } from "./llm";
import { AgentLog } from "./log-store";
import { createPersonTool, createRecallTool, createRememberTool, createStickerFinder } from "./memory-tools";
import { NOTE_EMBEDDING_KEY, NoteStore } from "./notes";
import { Outbox } from "./outbox";
import { createReactTool, createSayTool, createStickerTool } from "./outward-tools";
import { Recollection } from "./recollection";
import { talkShareNote } from "./talk-share";
import { markOwnSends } from "./qq-refs";
import type { RecordListener } from "./recorder";
import { AgentRuntime, loadAgentSystemPrompt, loadSleepPrompt } from "./runtime";
import { ToolRegistry, type AgentTool } from "./tools";

type Logger = ReturnType<Context["logger"]>;

export interface AgentShared {
  groups: GroupRegistry;
  events: EventStore;
  aliases: AliasRegistry;
  mediaDir: string;
  listeners: RecordListener[];
}

/** 启动新运行时；配置不满足时说明原因并返回 false，录制等其他功能不受影响 */
export function tryBootstrapAgent(ctx: Context, config: MioConfig, logger: Logger, shared: AgentShared): boolean {
  const { groups, events, aliases, mediaDir, listeners } = shared;
  const agent = config.agent;

  const openaiProvider = (id: string) => config.providers.find((p) => p.id === id && p.type === "openai" && p.apiKey);
  if (!openaiProvider(agent.model.providerId)) {
    logger.warn(`agent 模型的供应商 ${agent.model.providerId} 不存在、不是 OpenAI 兼容的或没有 API Key，新运行时未启动`);
    return false;
  }
  if (!openaiProvider(config.memory.embedding.providerId)) {
    logger.warn(`embedding 的供应商 ${config.memory.embedding.providerId} 不存在、不是 OpenAI 兼容的或没有 API Key，新运行时未启动`);
    return false;
  }

  const providers = new ProviderManager(config.providers);
  const embedding = new EmbeddingService(providers, config.memory.embedding);
  ctx.on("ready", async () => {
    await verifyEmbeddingModel(ctx, embedding, NOTE_EMBEDDING_KEY, ["mio.note"]);
    logger.info(`agent 记忆的 embedding 模型: ${embedding.modelName}`);
  });

  const notes = new NoteStore(ctx, embedding);
  const recollection = new Recollection(ctx, notes, aliases, agent.recollection);
  const outbox = new Outbox(agent.guards);
  const log = new AgentLog(ctx, aliases, {
    botName: config.botName,
    mediaDir,
    maxBatchEvents: agent.maxBatchEvents,
    annotate: async (groupId, batch) => {
      const recalled = await recollection.annotate(groupId, batch);
      const share = await talkShareNote(ctx, outbox, groupId);
      return share ? [...recalled, share] : recalled;
    },
  });

  const outwardDeps = { events, aliases, outbox, markOwn: markOwnSends(ctx) };
  const memoryDeps = { ctx, notes, aliases, events };
  const tools: AgentTool[] = [
    createSayTool(outwardDeps),
    createReactTool(outwardDeps),
    createStickerTool({ ...outwardDeps, stickers: createStickerFinder(ctx, notes, mediaDir) }),
    createRecallTool(memoryDeps),
    createPersonTool(memoryDeps),
    createRememberTool(memoryDeps),
  ];
  if (config.search.enabled && providers.hasProvider(config.search.compression.providerId)) {
    const search = new SearchService(new LLMClient(providers), {
      searxngBaseUrl: config.search.searxngBaseUrl,
      bangumiUserAgent: config.search.bangumiUserAgent,
      saucenaoApiKey: config.search.saucenaoApiKey,
      searchTimeoutMs: config.search.searchTimeoutMs,
      compressionModel: config.search.compression,
    });
    tools.push(createSearchTool(search), createFindSourceTool({ events, search, mediaDir }));
    ctx.on("dispose", () => search.dispose());
  } else {
    logger.info("搜索没有启用或压缩模型的供应商不存在，agent 不提供 search / find_source");
  }
  const registry = new ToolRegistry(tools, (call, error) => logger.error(`agent 工具 ${call.function.name} 出错:`, error));

  const runtime = new AgentRuntime(log, new AgentLLM(providers), registry, {
    model: agent.model,
    maxSteps: agent.maxSteps,
    systemPrompt: loadAgentSystemPrompt(agent.personaFile),
    isShadow: (groupId) => groups.isAgentShadow(groupId),
    sleep: {
      prompt: loadSleepPrompt(),
      maxSteps: agent.sleep.maxSteps,
      compactTokens: agent.sleep.compactTokens,
      idleMs: agent.sleep.idleHours * 3600_000,
      minTokens: agent.sleep.minTokens,
      tailEvents: agent.sleep.tailEvents,
    },
    onSegmentStart: (groupId) => recollection.resetSegment(groupId),
  }, logger);

  const debouncer = new Debouncer(config.debounce);
  const names = [config.botName, ...config.botAliases];
  const listener: RecordListener = (groupId, session, event) => {
    if (!groups.runsAgent(groupId)) return;
    const msg = event.body as NormalizedMessage;
    outbox.noteUserMessage(groupId, session);
    runtime.noteActivity(groupId);

    const text = msg.segments.map((s) => (s.type === "text" ? s.content : "")).join("");
    const engaged = msg.mentions.some((m) => m.isBot)
      || names.some((name) => text.includes(name))
      || (msg.replyTo !== undefined && outbox.isOwnMessage(groupId, msg.replyTo.messageId));

    debouncer.onMessage(groupId, msg, engaged, () => {
      const started = Date.now();
      runtime.wake(groupId)
        .then(() => {
          const last = outbox.lastSentAt(groupId);
          if (last !== undefined && last >= started) debouncer.markSpoke(groupId);
        })
        .catch((err) => logger.error(`[${groupId}] agent 唤醒失败:`, err));
    });
  };
  listeners.push(listener);

  ctx.on("dispose", () => {
    listeners.splice(listeners.indexOf(listener), 1);
    debouncer.dispose();
    runtime.dispose();
  });

  logger.info(`新运行时已就绪 (${agent.model.providerId}/${agent.model.modelName}，${tools.length} 个工具)`);
  return true;
}

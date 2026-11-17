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
import type { BanBody, EventStore } from "./event-store";
import { createImageTransport, type ImageTransport } from "./image-transport";
import { createFindSourceTool, createSearchTool } from "./inward-tools";
import { AgentLLM } from "./llm";
import { AgentLog, type GroupImages } from "./log-store";
import { agentModelFor, checkAgentModels } from "./models";
import { createPersonTool, createRecallTool, createRememberTool, createStickerFinder } from "./memory-tools";
import { NOTE_EMBEDDING_KEY, NoteStore } from "./notes";
import { Outbox } from "./outbox";
import { createReactTool, createRepeatTool, createSayTool, createStickerTool } from "./outward-tools";
import { Recollection } from "./recollection";
import { talkShareNote } from "./talk-share";
import type { GroupNames } from "./group-names";
import { markOwnSends } from "./qq-refs";
import { passiveReplyBlocker, recordPassiveReply } from "../platform/qq";
import type { RecordListener } from "./recorder";
import { AgentRuntime, loadAgentSystemPrompt, loadReminder, loadSleepPrompt } from "./runtime";
import { ToolRegistry, type AgentTool } from "./tools";

type Logger = ReturnType<Context["logger"]>;

export interface AgentShared {
  groups: GroupRegistry;
  events: EventStore;
  aliases: AliasRegistry;
  mediaDir: string;
  listeners: RecordListener[];
  groupNames: GroupNames;
}

/** 启动新运行时；配置不满足时说明原因并返回 false，录制等其他功能不受影响 */
export function tryBootstrapAgent(ctx: Context, config: MioConfig, logger: Logger, shared: AgentShared): boolean {
  const { groups, events, aliases, mediaDir, listeners, groupNames } = shared;
  const agent = config.agent;

  const modelUses = checkAgentModels(agent, config.providers);
  if (typeof modelUses === "string") {
    logger.warn(`${modelUses}，新运行时未启动`);
    return false;
  }
  const openaiProvider = (id: string) => config.providers.find((p) => p.id === id && p.type === "openai" && p.apiKey);
  if (!openaiProvider(config.memory.embedding.providerId)) {
    logger.warn(`embedding 的供应商 ${config.memory.embedding.providerId} 不存在、不是 OpenAI 兼容的或没有 API Key，新运行时未启动`);
    return false;
  }

  const providers = new ProviderManager(config.providers);
  // 发图方式跟着供应商走，每个供应商只建一个（DeepSeek 上传和缩图的去重都在实例里）
  const transports = new Map<string, ImageTransport>();
  for (const { label, provider } of modelUses) {
    if (transports.has(provider.id)) continue;
    const transport = createImageTransport(ctx, provider, { openai: providers.getOpenAIProvider(provider.id), anthropic: providers.getAnthropicProvider(provider.id) }, mediaDir);
    if (typeof transport === "string") {
      logger.warn(`${label}：${transport}`);
      return false;
    }
    transports.set(provider.id, transport);
  }
  const modelFor = agentModelFor(agent);
  const images: GroupImages = {
    of: (groupId) => transports.get(modelFor(groupId).providerId)!,
    all: [...transports.values()],
  };
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
    images,
    maxBatchEvents: agent.maxBatchEvents,
    groupName: (groupId) => groupNames.get(groupId),
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
    createRepeatTool({ ...outwardDeps, mediaDir }),
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
    modelFor,
    maxSteps: agent.maxSteps,
    systemPrompt: loadAgentSystemPrompt(agent.personaFile),
    reminder: loadReminder(),
    isShadow: (groupId) => groups.isShadow(groupId),
    sleep: {
      prompt: loadSleepPrompt(),
      maxSteps: agent.sleep.maxSteps,
      compactTokens: agent.sleep.compactTokens,
      minTokens: agent.sleep.minTokens,
      tailEvents: agent.sleep.tailEvents,
    },
    onSegmentStart: (groupId) => recollection.resetSegment(groupId),
  }, logger);

  const debouncer = new Debouncer(config.debounce);
  const names = [config.botName, ...config.botAliases];
  const listener: RecordListener = (groupId, session, event) => {
    if (!groups.runsAgent(groupId)) return;
    if (event.kind === "ban") {
      const ban = event.body as BanBody;
      if (ban.targetIsSelf) outbox.setBanned(groupId, ban.lift ? null : ban.durationSec > 0 ? event.timestamp + ban.durationSec * 1000 : Infinity);
      return;
    }
    // 表情回应只录不叫醒：下次醒来时随这批消息一起看到
    if (event.kind !== "message") return;
    const msg = event.body as NormalizedMessage;
    outbox.noteUserMessage(groupId, session);

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

  ctx.command("mio.status", "查看各群的模式、模型、log 长度和发送限制", { authority: 4 }).action(async () => {
    const groupIds = groups.list();
    if (groupIds.length === 0) return "没有开启任何群";
    const lines = await Promise.all(groupIds.map(async (groupId) => {
      const mode = groups.getMode(groupId);
      const model = modelFor(groupId);
      const parts = [`${groupId}（${mode}）`, `${model.providerId}/${model.modelName}`, `log ${await log.tokenCount(groupId)} tokens`];
      const blocked = outbox.blocker(groupId);
      if (blocked) parts.push(`发不出去：${blocked}`);
      return parts.join(" · ");
    }));
    return lines.join("\n");
  });

  ctx
    .command("mio.sleep", "让澪现在就睡前整理：把这个群的 log 压成新的一段", { authority: 4 })
    .action(async ({ session }) => {
      if (!session || session.isDirect) return "请在群里使用这个指令";
      const groupId = session.cid;
      if (!groups.runsAgent(groupId)) return "澪在这个群没有醒着（不是 on / shadow 模式）";
      const tokens = await log.tokenCount(groupId);
      if (tokens === 0) return "这个群的 log 是空的，不用整理";

      // 整理要跑好几分钟：先回一句，结果在被动回复窗口还在时再回；窗口过了只写日志，不占主动消息额度
      const reply = async (text: string) => {
        const blocked = passiveReplyBlocker(session);
        if (blocked) {
          logger.info(`[${groupId}] 手动整理的结果没回到群里（${blocked}）：${text}`);
          return;
        }
        await session.send(text);
        recordPassiveReply(session);
      };
      await reply(`开始整理了，这一段 log 有 ${tokens} tokens，要几分钟`);
      runtime.requestSleep(groupId, true).then(
        () => reply("整理完了，这个群的 log 收成了新的一段"),
        (err) => {
          logger.error(`[${groupId}] 手动整理失败:`, err);
          return reply(`整理失败：${err instanceof Error ? err.message : String(err)}`);
        },
      ).catch((err) => logger.error(`[${groupId}] 手动整理的结果发不出去:`, err));
    });

  ctx.on("dispose", () => {
    listeners.splice(listeners.indexOf(listener), 1);
    debouncer.dispose();
    runtime.dispose();
  });

  logger.info(`新运行时已就绪 (${agent.model.providerId}/${agent.model.modelName}，${tools.length} 个工具)`);
  for (const [groupId, model] of Object.entries(agent.groupModels)) {
    logger.info(`群 ${groupId} 的 agent 模型: ${model.providerId}/${model.modelName}`);
  }
  return true;
}

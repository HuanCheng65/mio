import * as path from "path";
import { Context } from "koishi";
import { } from "@koishijs/plugin-console";
import { Config } from "./config";
import type { Config as MioConfig } from "./config";
import { reloadPrompts } from "./memory/prompt-manager";
import { extendGroupFields, GroupRegistry } from "./runtime/groups";
import { registerGroupCommands } from "./runtime/group-commands";
import { MessageNormalizer } from "./perception/normalizer";
import { EventStore, extendEventTable } from "./agent/event-store";
import { MediaStore } from "./agent/media-store";
import { registerRecorder } from "./agent/recorder";
import { extendSentRefTable, trackSentRefs } from "./agent/qq-refs";
import { extendAliasTable } from "./agent/aliases";
import { extendLogTable } from "./agent/log-store";
import { extendImageTables } from "./agent/image-transport";
import { extendNoteTable } from "./agent/notes";
import { extendPromptTable, PromptStore } from "./agent/prompts";
import { AliasRegistry } from "./agent/aliases";
import { tryBootstrapAgent } from "./agent/bootstrap";
import { GroupNames } from "./agent/group-names";
import type { RecordListener } from "./agent/recorder";
import { extendTokenTable, tokenTracker } from "./llm/token-tracker";
import { extendMetaTable } from "./memory/embedding";
import { registerConsoleShell } from "./console/shell";
import { registerTokenStats } from "./console/token-stats";
import { ConfigService } from "./console/config-service";
import { registerConfigListeners } from "./console/config-listeners";
import { registerMemoryBrowser } from "./console/memory-browser";
import { registerPromptEditor } from "./console/prompt-editor";

export const name = "mio";
export const inject = ["database"];
export { Config };

export function apply(ctx: Context, config: MioConfig) {
  const logger = ctx.logger("mio");
  reloadPrompts();
  extendGroupFields(ctx);
  extendEventTable(ctx);
  extendAliasTable(ctx);
  extendLogTable(ctx);
  extendImageTables(ctx);
  extendNoteTable(ctx);
  extendPromptTable(ctx);
  extendSentRefTable(ctx);
  extendMetaTable(ctx);
  extendTokenTable(ctx);

  // token 用量统计不依赖运行时能否启动
  tokenTracker.init(ctx);
  registerTokenStats(ctx);
  const tokenFlushInterval = setInterval(() => tokenTracker.flush(), 60_000);
  ctx.on("dispose", async () => {
    clearInterval(tokenFlushInterval);
    await tokenTracker.flush();
  });

  // Phase A — 无条件挂载 Console 入口与 config 编辑接口，配置坏了也能从 UI 修复
  registerConsoleShell(ctx);
  const configService = new ConfigService(ctx, config, logger);
  registerConfigListeners(ctx, configService);

  // 群开关与录制不依赖模型配置：没配模型时也能先开启录制。
  // 事件流和别名在内存里维护编号和串行队列，录制器和新运行时必须共用同一个实例。
  const groups = new GroupRegistry(ctx);
  const events = new EventStore(ctx);
  const aliases = new AliasRegistry(ctx);
  const groupNames = new GroupNames(ctx, logger);
  const mediaDir = path.resolve(ctx.baseDir, "data/mio/media");
  const listeners: RecordListener[] = [];
  registerGroupCommands(ctx, groups, events, logger);
  trackSentRefs(ctx, logger);
  registerMemoryBrowser(ctx, groups, groupNames);
  const prompts = new PromptStore(ctx, config.agent.personaFile);
  registerPromptEditor(ctx, prompts, logger);
  registerRecorder(ctx, {
    groups,
    normalizer: new MessageNormalizer(config.botName),
    events,
    media: new MediaStore(mediaDir),
    logger,
    botName: config.botName,
    listeners,
  });

  // Phase B — 新运行时；配置不满足时保持 Phase A 存活，等待 UI 修复。
  tryBootstrapAgent(ctx, config, logger, { groups, events, aliases, mediaDir, listeners, groupNames, prompts });
}

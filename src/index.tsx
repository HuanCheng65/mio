import * as path from "path";
import { Context } from "koishi";
import { } from "@koishijs/plugin-console";
import { Config } from "./config";
import type { Config as MioConfig } from "./config";
import { reloadPrompts } from "./memory/prompt-manager";
import { extendPersonaTables } from "./persona/types";
import { extendGroupFields, GroupRegistry } from "./runtime/groups";
import { registerGroupCommands } from "./runtime/group-commands";
import { MessageNormalizer } from "./perception/normalizer";
import { EventStore, extendEventTable } from "./agent/event-store";
import { MediaStore } from "./agent/media-store";
import { registerRecorder } from "./agent/recorder";
import { extendSentRefTable, trackSentRefs } from "./agent/qq-refs";
import { extendAliasTable } from "./agent/aliases";
import { extendLogTable } from "./agent/log-store";
import { extendNoteTable } from "./agent/notes";
import { AliasRegistry } from "./agent/aliases";
import { tryBootstrapAgent } from "./agent/bootstrap";
import type { RecordListener } from "./agent/recorder";
import { extendTokenTable, tokenTracker } from "./llm/token-tracker";
import { extendMetaTable } from "./memory/embedding";
import { registerConsoleShell } from "./console/shell";
import { ConfigService } from "./console/config-service";
import { registerConfigListeners } from "./console/config-listeners";
import { tryBootstrapServices } from "./bootstrap";

export const name = "mio";
export const inject = ["database"];
export { Config };

export function apply(ctx: Context, config: MioConfig) {
  const logger = ctx.logger("mio");
  reloadPrompts();
  extendPersonaTables(ctx);
  extendGroupFields(ctx);
  extendEventTable(ctx);
  extendAliasTable(ctx);
  extendLogTable(ctx);
  extendNoteTable(ctx);
  extendSentRefTable(ctx);
  extendMetaTable(ctx);
  extendTokenTable(ctx);

  // token 用量统计是新旧运行时共用的，不依赖哪个运行时能否启动
  tokenTracker.init(ctx);
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
  const mediaDir = path.resolve(ctx.baseDir, "data/mio/media");
  const listeners: RecordListener[] = [];
  registerGroupCommands(ctx, groups, logger);
  trackSentRefs(ctx, logger);
  registerRecorder(ctx, {
    groups,
    normalizer: new MessageNormalizer(null, config.botName),
    events,
    media: new MediaStore(mediaDir),
    logger,
    botName: config.botName,
    listeners,
  });

  // Phase B + C — 服务初始化、运行时；任意守卫失败则保持 Phase A 存活，等待 UI 修复。
  // 旧运行时（on / shadow）和新运行时（agent）各自检查各自的配置，互不影响。
  tryBootstrapServices(ctx, config, logger, groups);
  tryBootstrapAgent(ctx, config, logger, { groups, events, aliases, mediaDir, listeners });
}

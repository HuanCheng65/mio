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
import { extendAliasTable } from "./agent/aliases";
import { extendLogTable } from "./agent/log-store";
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

  // Phase A — 无条件挂载 Console 入口与 config 编辑接口，配置坏了也能从 UI 修复
  registerConsoleShell(ctx);
  const configService = new ConfigService(ctx, config, logger);
  registerConfigListeners(ctx, configService);

  // 群开关与录制不依赖模型配置：没配模型时也能先开启录制
  const groups = new GroupRegistry(ctx);
  registerGroupCommands(ctx, groups, logger);
  registerRecorder(ctx, {
    groups,
    normalizer: new MessageNormalizer(null, config.botName),
    events: new EventStore(ctx),
    media: new MediaStore(path.resolve(ctx.baseDir, "data/mio/media")),
    logger,
  });

  // Phase B + C — 服务初始化、运行时；任意守卫失败则保持 Phase A 存活，等待 UI 修复
  tryBootstrapServices(ctx, config, logger, groups);
}

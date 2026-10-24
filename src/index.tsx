import { Context } from "koishi";
import { } from "@koishijs/plugin-console";
import { Config } from "./config";
import type { Config as MioConfig } from "./config";
import { reloadPrompts } from "./memory/prompt-manager";
import { extendPersonaTables } from "./persona/types";
import { extendGroupFields } from "./runtime/groups";
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

  // Phase A — 无条件挂载 Console 入口与 config 编辑接口，配置坏了也能从 UI 修复
  registerConsoleShell(ctx);
  const configService = new ConfigService(ctx, config, logger);
  registerConfigListeners(ctx, configService);

  // Phase B + C — 服务初始化、运行时；任意守卫失败则保持 Phase A 存活，等待 UI 修复
  tryBootstrapServices(ctx, config, logger);
}

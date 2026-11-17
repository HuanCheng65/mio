import { Context } from "koishi";
import { tokenTracker, TokenStats } from "../llm/token-tracker";

declare module "@koishijs/plugin-console" {
  interface Events {
    "mio/token-stats"(): Promise<TokenStats>;
    "mio/token-stats-reset"(): Promise<string>;
  }
}

/** token 用量的 Console 接口和 mio.tokens 指令；不依赖运行时能否启动 */
export function registerTokenStats(ctx: Context): void {
  ctx.inject(["console"], (ctx) => {
    ctx.console.addListener("mio/token-stats", () => tokenTracker.getStats());
    ctx.console.addListener("mio/token-stats-reset", async () => {
      await tokenTracker.reset();
      return "统计已重置";
    });
  });

  ctx.command("mio.tokens", "查看 token 用量", { authority: 4 }).action(async () => {
    const stats = await tokenTracker.getStats();
    const lines: string[] = [];

    lines.push(`总调用: ${stats.totalCalls} 次`);
    lines.push(`总量: ${stats.totalPromptTokens} prompt + ${stats.totalCompletionTokens} completion (cached: ${stats.totalCachedTokens}, cache write: ${stats.totalCacheWriteTokens})`);

    for (const [model, usage] of Object.entries(stats.byModel)) {
      lines.push(`  ${model}: ${usage.promptTokens}p + ${usage.completionTokens}c (cached: ${usage.cachedTokens}, cache write: ${usage.cacheWriteTokens}), ${usage.calls} 次`);
    }

    return lines.join("\n");
  });
}

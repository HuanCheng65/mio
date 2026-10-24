import { reloadPrompts } from "../memory/prompt-manager";
import { tokenTracker } from "../llm/token-tracker";
import type { RuntimeDeps, RuntimeState } from "./types";
import type { MioGroupMode } from "./groups";

const MODE_LABELS: Record<MioGroupMode, string> = {
  on: "已在本群开启",
  shadow: "已在本群开启影子模式（正常推理但不发送消息，记录到日志）",
  off: "已在本群关闭",
};

export function registerAdminCommands(
  deps: RuntimeDeps,
  state: RuntimeState,
  preloadGroup: (groupId: string) => Promise<void>,
): void {
  const { ctx, logger, groups, geminiCacheManager } = deps;

  ctx.command("mio", "澪管理指令", { authority: 4 });

  for (const mode of ["on", "shadow", "off"] as const) {
    ctx
      .command(`mio.${mode}`, MODE_LABELS[mode].replace(/^已在/, "在"), { authority: 4 })
      .channelFields(["mioMode"])
      .action(async ({ session }) => {
        if (!session || session.isDirect) return "请在群里使用这个指令";
        const groupId = session.cid;
        session.channel.mioMode = mode;
        groups.set(groupId, mode);
        logger.info(`[admin] ${groupId} 切换为 ${mode}`);
        if (mode !== "off") await preloadGroup(groupId);
        return `${MODE_LABELS[mode]}（群 ID: ${groupId}）`;
      });
  }

  ctx.command("mio.reload", "重载 prompt 模板和人设文件", { authority: 4 }).action(async () => {
    try {
      reloadPrompts();
      if (geminiCacheManager) {
        await geminiCacheManager.invalidateAllCaches();
      }
      logger.info("[admin] prompt 模板已重载（数据库人设不受此命令影响）");
      return "prompt 模板已重载。数据库人设请通过 console persona studio 管理。";
    } catch (err) {
      logger.error("[admin] 重载失败:", err);
      return `重载失败: ${err}`;
    }
  });

  ctx.command("mio.status", "查看运行状态", { authority: 4 }).action(async () => {
    const lines: string[] = [];

    const enabled = groups.list().map((g) => (groups.isShadow(g) ? `${g}（影子）` : g));
    lines.push(`监听群: ${enabled.length > 0 ? enabled.join(", ") : "无"}`);

    const mutedGroups = [...state.botMutedGroups.entries()].filter(([, v]) => v).map(([k]) => k);
    lines.push(`静默群: ${mutedGroups.length > 0 ? mutedGroups.join(", ") : "无"}`);

    const activeGroups = [...state.activeRequests.keys()];
    lines.push(`进行中的请求: ${activeGroups.length > 0 ? activeGroups.join(", ") : "无"}`);

    if (state.hourlyReplies.size > 0) {
      const replyParts = [...state.hourlyReplies.entries()].map(([g, c]) => `${g}: ${c}`);
      lines.push(`本小时回复: ${replyParts.join(", ")}`);
    } else {
      lines.push("本小时回复: 0");
    }

    return lines.join("\n");
  });

  ctx.command("mio.mute <groupId:string>", "静默指定群", { authority: 4 }).action(async (_, groupId) => {
    if (!groupId) return "请指定群 ID（形如 qq:xxxx，可用 mio.status 查看）";
    state.botMutedGroups.set(groupId, true);
    logger.info(`[admin] 手动静默群 ${groupId}`);
    return `已静默群 ${groupId}`;
  });

  ctx.command("mio.unmute <groupId:string>", "解除指定群静默", { authority: 4 }).action(async (_, groupId) => {
    if (!groupId) return "请指定群 ID（形如 qq:xxxx，可用 mio.status 查看）";
    state.botMutedGroups.delete(groupId);
    logger.info(`[admin] 解除群 ${groupId} 静默`);
    return `已解除群 ${groupId} 的静默`;
  });

  ctx.command("mio.tokens", "查看 token 用量", { authority: 4 }).action(async () => {
    const stats = await tokenTracker.getStats();
    const lines: string[] = [];

    lines.push(`总调用: ${stats.totalCalls} 次`);
    lines.push(`总量: ${stats.totalPromptTokens} prompt + ${stats.totalCompletionTokens} completion (cached: ${stats.totalCachedTokens})`);

    for (const [model, usage] of Object.entries(stats.byModel)) {
      lines.push(`  ${model}: ${usage.promptTokens}p + ${usage.completionTokens}c (cached: ${usage.cachedTokens}), ${usage.calls} 次`);
    }

    return lines.join("\n");
  });
}

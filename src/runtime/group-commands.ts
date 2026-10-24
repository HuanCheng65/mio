import { Context } from "koishi";
import type { GroupRegistry, MioGroupMode } from "./groups";

const MODE_LABELS: Record<MioGroupMode, string> = {
  record: "已在本群开启录制（只记录群聊，不回复）",
  on: "已在本群开启",
  shadow: "已在本群开启影子模式（正常推理但不发送消息，记录到日志）",
  agent: "已在本群开启新运行时（agent）",
  "agent-shadow": "已在本群开启新运行时的影子模式（照常思考和记笔记，但不发消息）",
  off: "已在本群关闭",
};

/** 群开关不依赖模型配置：没配模型时也要能开启录制 */
export function registerGroupCommands(ctx: Context, groups: GroupRegistry, logger: ReturnType<Context["logger"]>): void {
  ctx.command("mio", "澪管理指令", { authority: 4 });

  for (const mode of ["record", "on", "shadow", "agent", "agent-shadow", "off"] as const) {
    ctx
      .command(`mio.${mode}`, MODE_LABELS[mode].replace(/^已在/, "在"), { authority: 4 })
      .channelFields(["mioMode"])
      .action(async ({ session }) => {
        if (!session || session.isDirect) return "请在群里使用这个指令";
        const groupId = session.cid;
        session.channel.mioMode = mode;
        await groups.set(groupId, mode);
        logger.info(`[admin] ${groupId} 切换为 ${mode}`);
        return `${MODE_LABELS[mode]}（群 ID: ${groupId}）`;
      });
  }
}

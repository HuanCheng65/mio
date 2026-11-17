import { Context, Session } from "koishi";
import type { EventStore, MuteBody } from "../agent/event-store";
import type { GroupRegistry, MioGroupMode } from "./groups";

type Logger = ReturnType<Context["logger"]>;

const MODE_LABELS: Record<Exclude<MioGroupMode, "muted">, string> = {
  record: "已在本群开启录制（只记录群聊，澪不醒）",
  on: "已在本群开启澪",
  shadow: "已在本群开启影子模式（澪照常思考和记笔记，但发出去的话被拦下，她自己不知道）",
  off: "已在本群关闭",
};

/** 群开关不依赖模型配置：没配模型时也要能开启录制 */
export function registerGroupCommands(ctx: Context, groups: GroupRegistry, events: EventStore, logger: Logger): void {
  ctx.command("mio", "澪管理指令", { authority: 4 });

  /** 静音的进入和解除写进事件流，澪下次醒来能在 log 里看到 */
  async function noteMute(groupId: string, muted: boolean): Promise<void> {
    await events.append(groupId, async () => ({
      kind: "mute",
      platformMessageId: "",
      userId: "",
      isBot: false,
      timestamp: Date.now(),
      body: { muted } satisfies MuteBody,
    }));
  }

  async function switchMode(session: Session<never, "mioMode">, mode: MioGroupMode): Promise<void> {
    const groupId = session.cid;
    const previous = groups.getMode(groupId);
    // 先写通知再切模式：切到 off 之后就不再录制了
    if (previous === "muted" && mode !== "muted") await noteMute(groupId, false);
    if (mode === "muted") await noteMute(groupId, true);
    session.channel.mioMode = mode;
    groups.set(groupId, mode);
    logger.info(`[admin] ${groupId} ${previous} → ${mode}`);
  }

  for (const mode of ["record", "on", "shadow", "off"] as const) {
    ctx
      .command(`mio.${mode}`, MODE_LABELS[mode].replace(/^已在/, "在"), { authority: 4 })
      .channelFields(["mioMode"])
      .action(async ({ session }) => {
        if (!session || session.isDirect) return "请在群里使用这个指令";
        await switchMode(session, mode);
        return `${MODE_LABELS[mode]}（群 ID: ${session.cid}）`;
      });
  }

  ctx
    .command("mio.mute", "让澪在本群先别说话（只录制不醒，她知道自己被静音了）", { authority: 4 })
    .channelFields(["mioMode"])
    .action(async ({ session }) => {
      if (!session || session.isDirect) return "请在群里使用这个指令";
      const mode = groups.getMode(session.cid);
      if (mode === "muted") return "澪在本群已经是静音了";
      if (mode !== "on" && mode !== "shadow") return `澪在本群没醒着（当前模式 ${mode}），不用静音`;
      await switchMode(session, "muted");
      return "已在本群静音澪（mio.unmute 解除）";
    });

  ctx
    .command("mio.unmute", "解除澪在本群的静音", { authority: 4 })
    .channelFields(["mioMode"])
    .action(async ({ session }) => {
      if (!session || session.isDirect) return "请在群里使用这个指令";
      const mode = groups.getMode(session.cid);
      if (mode !== "muted") return `澪在本群没有被静音（当前模式 ${mode}）`;
      await switchMode(session, "on");
      return "已解除静音，澪下次看群时会知道";
    });
}

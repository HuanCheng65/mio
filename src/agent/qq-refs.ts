import type { Context } from "koishi";
import type { NormalizedMessage } from "../perception/types";
import type { EventStore } from "./event-store";

/**
 * 官方 QQ 的引用消息不带被引用消息的 ID，只给一个引用索引（ref_msg_idx）。
 * 群友消息的索引随消息事件到达，存在 mio.event.refIdx；这个号自己发的消息的索引
 * 只出现在发送接口的响应里（ext_info.ref_idx），适配器会丢掉它，所以在发送这一层截下来存进这张表。
 */
export interface MioSentRefRow {
  id: number;
  groupId: string;
  refIdx: string;
  messageId: string;
  createdAt: number;
}

declare module "koishi" {
  interface Tables {
    "mio.sent_ref": MioSentRefRow;
  }
}

export function extendSentRefTable(ctx: Context): void {
  ctx.model.extend("mio.sent_ref", {
    id: "unsigned",
    groupId: "string(63)",
    refIdx: "string(255)",
    messageId: "string(127)",
    createdAt: "unsigned(8)",
  }, {
    autoInc: true,
    primary: "id",
    unique: [["groupId", "refIdx"]],
  });
}

type Logger = ReturnType<Context["logger"]>;

/** 包住官方 QQ 机器人的群消息发送接口，记下每条发出去的消息的引用索引 */
export function trackSentRefs(ctx: Context, logger: Logger): void {
  const wrap = (bot: Context["bots"][number]) => {
    if (bot.platform !== "qq" || !bot.internal) return;
    const internal = bot.internal as any;
    if (internal.__mioSentRefs) return;
    internal.__mioSentRefs = true;
    const send = internal.sendMessage.bind(internal);
    internal.sendMessage = async (channelId: string, data: unknown) => {
      const resp = await send(channelId, data);
      const refIdx: unknown = resp?.ext_info?.ref_idx;
      if (typeof resp?.id !== "string" || typeof refIdx !== "string") {
        // 消息已经发出去了，这里抛错会让适配器以为发送失败；只报告，别人引用这条时会显示成没对上
        logger.warn(`官方 QQ 发送响应里没有消息 ID 或 ext_info.ref_idx，记不下引用索引: ${JSON.stringify(resp)}`);
        return resp;
      }
      await ctx.database.create("mio.sent_ref", { groupId: `qq:${channelId}`, refIdx, messageId: resp.id, createdAt: Date.now() });
      return resp;
    };
  };
  ctx.on("ready", () => ctx.bots.forEach(wrap));
  ctx.on("bot-status-updated", wrap);
}

/**
 * 把官方 QQ 引用里的引用索引换成被引用消息的平台 ID 和发送者，之后的渲染和"有人在回复澪"的判断照常按 ID 走。
 * 查不到（录制开始前的消息，或者索引对不上）时保持 messageId 为空，渲染成没对上的引用。
 */
export async function resolveQQReply(ctx: Context, events: EventStore, groupId: string, msg: NormalizedMessage, botName: string): Promise<void> {
  const reply = msg.replyTo;
  if (!reply?.refIdx) return;
  const event = await events.findByRefIdx(groupId, reply.refIdx);
  if (event) {
    reply.messageId = event.platformMessageId;
    reply.sender = (event.body as NormalizedMessage).sender;
    return;
  }
  const [sent] = await ctx.database.get("mio.sent_ref", { groupId, refIdx: reply.refIdx });
  if (sent) {
    reply.messageId = sent.messageId;
    reply.sender = botName;
    reply.fromBot = true;
  }
}

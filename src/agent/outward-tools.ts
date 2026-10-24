import { readFile } from "node:fs/promises";
import { h } from "koishi";
import { humanizedSend, type DeliveryOptions } from "../delivery/humanize";
import { ALLOWED_REACT_EMOJI_NAMES, findEmoji, stickerMimeType } from "../helpers";
import { setMsgEmojiLike } from "../platform/onebot";
import { passiveReplyBlocker, recordPassiveReply } from "../platform/qq";
import type { AliasRegistry } from "./aliases";
import type { EventStore, MioEventRow } from "./event-store";
import type { Outbox } from "./outbox";
import type { AgentTool, ToolContext } from "./tools";

export interface StickerFinder {
  /** 按想表达的感觉找一张收藏的表情包；返回图片的绝对路径 */
  find(feeling: string): Promise<{ path: string; description: string } | null>;
}

export interface OutwardDeps {
  events: EventStore;
  aliases: AliasRegistry;
  outbox: Outbox;
  delivery?: DeliveryOptions;
}

const SHADOW = "（影子模式：没有真的发出去）";
const MAX_STICKER_BYTES = 2 * 1024 * 1024;

async function findMessage(events: EventStore, groupId: string, ref: unknown): Promise<MioEventRow | string> {
  const match = /^m?(\d+)$/.exec(String(ref ?? "").trim());
  if (!match) return `消息编号要写成 m12 这样，收到的是：${ref}`;
  const event = await events.get(groupId, Number(match[1]));
  if (!event || event.kind !== "message") return `找不到 m${match[1]} 这条消息`;
  return event;
}

/** 把 say 的文本转成消息元素：转义正文，@#别名 换成真正的 @ */
async function compose(text: string, ctx: ToolContext, aliases: AliasRegistry): Promise<string> {
  const pattern = /@[^\s@#]*#(a\d+)/g;
  let out = "";
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const userId = await aliases.userOf(ctx.groupId, m[1]);
    if (!userId) throw new UnknownAlias(m[1]);
    out += h.escape(text.slice(last, m.index)) + `<at id="${h.escape(userId, true)}"/>`;
    last = m.index! + m[0].length;
  }
  return out + h.escape(text.slice(last));
}

class UnknownAlias extends Error {
  constructor(readonly alias: string) {
    super(alias);
  }
}

export function createSayTool(deps: OutwardDeps): AgentTool {
  return {
    name: "say",
    outward: true,
    description:
      "在群里说一句话。这是你在群里出声的方式，不想说就不用调用。" +
      "一次 say 就是一条消息，想分几条说就调用几次。@ 某人写 @#别名（如 @#a3）。" +
      "如果被拦下（比如刚说过太多），结果里会告诉你原因，照着做就行。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要说的话，就是群友会看到的原文" },
        reply_to: { type: "string", description: "可选。想引用回复某条消息时填它的编号，如 m12；接着话题说一般不需要" },
      },
      required: ["text"],
    },
    async run(args, ctx) {
      const text = String(args.text ?? "").trim();
      if (!text) return "没有内容，没发";
      const guard = deps.outbox.blocker(ctx.groupId);
      if (guard) return guard;

      let content: string;
      try {
        content = await compose(text, ctx, deps.aliases);
      } catch (err) {
        if (err instanceof UnknownAlias) return `不认识 #${err.alias}，@ 人要用记录里出现过的别名。这次没发`;
        throw err;
      }
      if (args.reply_to !== undefined && args.reply_to !== "") {
        const target = await findMessage(deps.events, ctx.groupId, args.reply_to);
        if (typeof target === "string") return `${target}，这次没发`;
        content = `<quote id="${h.escape(target.platformMessageId, true)}"/>${content}`;
      }

      if (ctx.shadow) {
        deps.outbox.recordSent(ctx.groupId, []);
        return SHADOW;
      }
      const session = deps.outbox.latestSession(ctx.groupId);
      if (!session) return "现在没有可以挂靠回复的消息（重启后还没人说过话），这次发不出去";

      const { sentParts, messageIds, blocked } = await humanizedSend(session, content, deps.delivery);
      if (sentParts.length > 0) deps.outbox.recordSent(ctx.groupId, messageIds);
      if (blocked && sentParts.length === 0) return `没发出去：${blocked}`;
      if (blocked) return `只发出去了前 ${sentParts.length} 段：${blocked}`;
      return "发出去了";
    },
  };
}

export function createReactTool(deps: OutwardDeps): AgentTool {
  return {
    name: "react",
    outward: true,
    description:
      "给某条消息点一个表情回应，群里会看到你点了。适合\"看到了、有感觉，但没什么要说的\"。" +
      `能用的表情：${ALLOWED_REACT_EMOJI_NAMES.join("、")}。点了就别再用 say 说同一个意思。`,
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "消息编号，如 m12" },
        emoji: { type: "string", description: "表情名，必须是上面列出的之一" },
      },
      required: ["message", "emoji"],
    },
    available: (platform) => platform === "onebot",
    async run(args, ctx) {
      const target = await findMessage(deps.events, ctx.groupId, args.message);
      if (typeof target === "string") return target;
      const emoji = findEmoji(String(args.emoji ?? ""), { allowedNames: ALLOWED_REACT_EMOJI_NAMES, maxDistance: 0 });
      if (!emoji) return `不能用"${args.emoji}"，能用的是：${ALLOWED_REACT_EMOJI_NAMES.join("、")}`;
      if (ctx.shadow) return SHADOW;
      const session = deps.outbox.latestSession(ctx.groupId);
      if (!session) return "现在没有可用的会话，这次点不了";
      await setMsgEmojiLike(session, target.platformMessageId, emoji.id);
      return `给 m${target.seq} 点了${emoji.name}`;
    },
  };
}

export function createStickerTool(deps: OutwardDeps & { stickers: StickerFinder }): AgentTool {
  return {
    name: "sticker",
    outward: true,
    description:
      "从你攒的表情包里挑一张发出去。用一句话描述想表达的感觉或画面，比如\"憋笑 猫\"\"震惊 瞪大眼睛\"。" +
      "一次最多一张，找不到合适的就算了。",
    parameters: {
      type: "object",
      properties: { feeling: { type: "string", description: "想表达的感觉或画面关键词" } },
      required: ["feeling"],
    },
    async run(args, ctx) {
      const feeling = String(args.feeling ?? "").trim();
      if (!feeling) return "没说想要什么样的，没发";
      const guard = deps.outbox.blocker(ctx.groupId);
      if (guard) return guard;
      const found = await deps.stickers.find(feeling);
      if (!found) return `没找到"${feeling}"这样的表情包`;
      const image = await readFile(found.path);
      if (image.length > MAX_STICKER_BYTES) return `找到的那张太大了，发不了（${found.description}）`;

      if (ctx.shadow) {
        deps.outbox.recordSent(ctx.groupId, []);
        return `${SHADOW}：${found.description}`;
      }
      const session = deps.outbox.latestSession(ctx.groupId);
      if (!session) return "现在没有可以挂靠回复的消息，这次发不出去";
      const blocked = passiveReplyBlocker(session);
      if (blocked) return `没发出去：${blocked}`;
      const ids = await session.send(h.image(image, stickerMimeType(found.path)));
      recordPassiveReply(session);
      deps.outbox.recordSent(ctx.groupId, ids);
      return `发了：${found.description}`;
    },
  };
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { h } from "koishi";
import { humanizedSend, type DeliveryOptions } from "../delivery/humanize";
import { ALLOWED_REACT_EMOJI_NAMES, findEmoji, stickerMimeType } from "../helpers";
import { setMsgEmojiLike } from "../platform/onebot";
import type { NormalizedMessage } from "../perception/types";
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
  /** 记下哪些平台消息是澪自己说的（区别于同一个号上的指令回复） */
  markOwn: (groupId: string, messageIds: string[]) => Promise<void>;
}

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
        return "发出去了";
      }
      const session = deps.outbox.latestSession(ctx.groupId);
      if (!session) return "现在没有可以挂靠回复的消息（重启后还没人说过话），这次发不出去";

      const { sentParts, messageIds, blocked } = await humanizedSend(session, content, deps.delivery);
      if (sentParts.length > 0) {
        deps.outbox.recordSent(ctx.groupId, messageIds);
        await deps.markOwn(ctx.groupId, messageIds);
      }
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
      if (ctx.shadow) return `给 m${target.seq} 点了${emoji.name}`;
      const session = deps.outbox.latestSession(ctx.groupId);
      if (!session) return "现在没有可用的会话，这次点不了";
      await setMsgEmojiLike(session, target.platformMessageId, emoji.id);
      return `给 m${target.seq} 点了${emoji.name}`;
    },
  };
}

/** 复读要趁热：太久以前的消息不复读 */
const REPEAT_MAX_AGE_MS = 5 * 60_000;
/** 复读是偶尔的梗，同一个群两次复读至少隔这么久 */
const REPEAT_COOLDOWN_MS = 10 * 60_000;

/** 把一条群友消息原样还原成消息元素；有还原不了的内容时给出原因 */
async function replayContent(event: MioEventRow, mediaDir: string): Promise<{ content: string } | { refused: string }> {
  const msg = event.body as NormalizedMessage;
  if (msg.mentions.length > 0) return { refused: "带 @ 的消息不复读" };
  let content = "";
  for (const seg of msg.segments) {
    if (seg.type === "text") content += h.escape(seg.content);
    else if (seg.type === "face") content += h("face", { id: seg.faceId }).toString();
    else if (seg.type === "image") {
      if (!seg.file) return { refused: "那张图当时没存下来，复读不了" };
      const path = join(mediaDir, seg.file);
      content += h.image(await readFile(path), stickerMimeType(path)).toString();
    } else return { refused: `这条里有${seg.type}，没法原样复读` };
  }
  return content ? { content } : { refused: "这条是空的" };
}

export function createRepeatTool(deps: OutwardDeps & { mediaDir: string }): AgentTool {
  const lastRepeatAt = new Map<string, number>();
  return {
    name: "repeat",
    outward: true,
    description:
      "复读：把群友刚发的某条消息原样再发一遍，一个字、一个标点都不改，图和表情也照搬。" +
      "群里有人在复读、或者某句话好笑到值得跟一句的时候用。只能复读几分钟内别人发的消息，而且不能常用。",
    parameters: {
      type: "object",
      properties: { message: { type: "string", description: "要复读的消息编号，如 m12" } },
      required: ["message"],
    },
    async run(args, ctx) {
      const target = await findMessage(deps.events, ctx.groupId, args.message);
      if (typeof target === "string") return `${target}，没复读`;
      if (target.isBot) return "不复读自己说过的话";
      if (Date.now() - target.timestamp > REPEAT_MAX_AGE_MS) return "这条已经过去好几分钟了，复读要趁热，没复读";
      const last = lastRepeatAt.get(ctx.groupId);
      if (last !== undefined && Date.now() - last < REPEAT_COOLDOWN_MS) return "刚复读过，这次就算了";
      const guard = deps.outbox.blocker(ctx.groupId);
      if (guard) return guard;

      const replayed = await replayContent(target, deps.mediaDir);
      if ("refused" in replayed) return `${replayed.refused}，没复读`;
      const { content } = replayed;
      lastRepeatAt.set(ctx.groupId, Date.now());

      if (ctx.shadow) {
        deps.outbox.recordSent(ctx.groupId, []);
        return `复读了 m${target.seq}`;
      }
      const session = deps.outbox.latestSession(ctx.groupId);
      if (!session) return "现在没有可以挂靠回复的消息，这次发不出去";
      const blocked = passiveReplyBlocker(session);
      if (blocked) return `没发出去：${blocked}`;
      const ids = await session.send(content);
      recordPassiveReply(session);
      deps.outbox.recordSent(ctx.groupId, ids);
      await deps.markOwn(ctx.groupId, ids);
      return `复读了 m${target.seq}`;
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
        return `发了：${found.description}`;
      }
      const session = deps.outbox.latestSession(ctx.groupId);
      if (!session) return "现在没有可以挂靠回复的消息，这次发不出去";
      const blocked = passiveReplyBlocker(session);
      if (blocked) return `没发出去：${blocked}`;
      const ids = await session.send(h.image(image, stickerMimeType(found.path)));
      recordPassiveReply(session);
      deps.outbox.recordSent(ctx.groupId, ids);
      await deps.markOwn(ctx.groupId, ids);
      return `发了：${found.description}`;
    },
  };
}

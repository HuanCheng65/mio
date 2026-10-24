import type { ImageSegment, MessageSegment, NormalizedMessage } from "../perception/types";
import type { MioEventRow } from "./event-store";

/** log 里存的内容片段；图片只存文件名，发请求时再读成 base64，保证每次字节相同、能命中缓存 */
export type LogPart = { type: "text"; text: string } | { type: "image"; file: string };

export interface BatchContext {
  /** 平台用户 ID → 群内短别名 */
  aliases: Map<string, string>;
  /** 平台用户 ID → 最近见到的昵称（用于还没说过话、@ 里只有平台 ID 的人） */
  names: Map<string, string>;
  /** 平台消息 ID → 事件 seq，用来把回复和撤回指回 [mN] */
  seqByMessageId: Map<string, number>;
  botName: string;
  /** 因积压过多而没有渲染的更早事件数 */
  skipped?: number;
  /** 附在这一批末尾的旁注（人物卡片、隐约记得等） */
  annotations?: string[];
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const pad = (n: number) => String(n).padStart(2, "0");

function dateHeader(ts: number): string {
  const d = new Date(ts);
  return `〔${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${WEEKDAYS[d.getDay()]}〕`;
}

function clock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderSegment(seg: MessageSegment): string {
  switch (seg.type) {
    case "text":
      return seg.content;
    case "face":
      return `[表情:${seg.name}]`;
    case "share":
      return `[分享${seg.platform ? `·${seg.platform}` : ""}：${seg.title}${seg.description ? ` ${seg.description}` : ""}]`;
    case "forward":
      return `[${seg.summary}]`;
    case "poke":
      return `[${seg.action} ${seg.target}]`;
    case "notice":
      return seg.content;
    case "unsupported":
      return seg.hint;
    case "recall":
    case "image":
      return "";
  }
}

interface RenderedMessage {
  line: string;
  /** 这条消息里保存下来的图，紧跟在这一行后面附上 */
  images: { label: string; file: string }[];
}

function renderMessage(seq: number, msg: NormalizedMessage, ctx: BatchContext): RenderedMessage {
  const alias = ctx.aliases.get(msg.senderId);
  if (!msg.isBot && !alias) throw new Error(`renderBatch: no alias for sender ${msg.senderId}`);
  const who = msg.isBot ? `${ctx.botName}（你）` : `${msg.senderRole ? `【${msg.senderRole}】` : ""}${msg.sender}#${alias}`;

  let reply = "";
  if (msg.replyTo) {
    const target = ctx.seqByMessageId.get(msg.replyTo.messageId);
    const quoted = msg.replyTo.fromSelf ? `${ctx.botName}（你）`
      // 官方 QQ 的引用按索引没对上时，平台不给被引用者是谁
      : msg.replyTo.refIdx && !msg.replyTo.messageId ? "一条没对上的消息"
      : msg.replyTo.sender;
    reply = target !== undefined ? `↩m${target} ` : `↩${quoted}「${msg.replyTo.preview}」 `;
  }

  const imageSegs = msg.segments.filter((s): s is ImageSegment => s.type === "image");
  const images: RenderedMessage["images"] = [];
  let imageIndex = 0;
  let body = "";
  for (const seg of msg.segments) {
    if (seg.type !== "image") {
      body += renderSegment(seg);
      continue;
    }
    imageIndex++;
    const kind = seg.isSticker ? "表情包" : "图";
    const n = imageSegs.length > 1 ? String(imageIndex) : "";
    if (!seg.file) {
      body += `[${kind}${n}：没能保存]`;
      continue;
    }
    body += `[${kind}${n}]`;
    images.push({ label: `[m${seq} ${who} 发的${kind}${n}]`, file: seg.file });
  }

  for (const mention of msg.mentions) {
    if (mention.isBot) continue;
    const mentionAlias = ctx.aliases.get(mention.userId);
    if (!mentionAlias) throw new Error(`renderBatch: no alias for mentioned user ${mention.userId}`);
    // 平台没给名字时 normalizer 会把平台 ID 当显示名
    const name = mention.displayName === mention.userId ? ctx.names.get(mention.userId) ?? "某人" : mention.displayName;
    body = body.replace(`@${mention.displayName}`, `@${name}#${mentionAlias}`);
  }

  return { line: `[m${seq}] ${who} ${clock(msg.timestamp)}: ${reply}${body.trimStart()}`, images };
}

/**
 * 把一批事件渲染成一条 user 消息的内容。第一个片段总是文字（日期开头）。
 * 图片紧跟在发它的那一行后面并标上发送者：统一挂在末尾时，模型会按位置把图算到最后说话的人头上。
 */
export function renderBatch(events: MioEventRow[], ctx: BatchContext): LogPart[] {
  if (events.length === 0) throw new Error("renderBatch: empty batch");
  const parts: LogPart[] = [];
  let lines: string[] = [dateHeader(events[0].timestamp)];
  if (ctx.skipped) lines.push(`〔之前还有 ${ctx.skipped} 条消息没看到〕`);
  const flush = () => {
    if (lines.length > 0) parts.push({ type: "text", text: lines.join("\n") });
    lines = [];
  };

  for (const event of events) {
    if (event.kind === "recall") {
      const body = event.body as { recalledMessageId: string; recalledBy: string };
      const target = ctx.seqByMessageId.get(body.recalledMessageId);
      lines.push(`〔${body.recalledBy || "有人"} 撤回了${target !== undefined ? ` m${target}` : "一条消息"}〕`);
      continue;
    }
    const { line, images } = renderMessage(event.seq, event.body as NormalizedMessage, ctx);
    lines.push(line);
    for (const image of images) {
      lines.push(image.label);
      flush();
      parts.push({ type: "image", file: image.file });
    }
  }
  lines.push(...(ctx.annotations ?? []));
  flush();
  return parts;
}

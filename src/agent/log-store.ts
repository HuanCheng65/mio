import { $, Context } from "koishi";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { NormalizedMessage } from "../perception/types";
import type { AliasRegistry } from "./aliases";
import type { MioEventRow } from "./event-store";
import { renderBatch, type LogPart } from "./log-format";
import { estimateTokens, IMAGE_TOKENS } from "./tokens";

/**
 * 每个群一条只追加的 log，就是发给模型的上下文。条目一旦写入就不再改动：
 * 重新渲染（哪怕只是改了渲染代码）都会改变前缀、打掉缓存。
 * segment 是压缩代数：压缩后开新的一段，旧段保留作记录。
 */
export type LogRole = "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface MioLogEntryRow {
  id: number;
  groupId: string;
  segment: number;
  role: LogRole;
  content: LogPart[];
  toolCalls: ToolCall[] | null;
  toolCallId: string | null;
  /** assistant 条目的推理内容（思考模式），原样发回以保持前缀稳定 */
  reasoning: string | null;
  /** user 批次覆盖到的最后一个事件 seq */
  lastSeq: number | null;
  tokens: number;
  createdAt: number;
}

declare module "koishi" {
  interface Tables {
    "mio.log_entry": MioLogEntryRow;
  }
}

export function extendLogTable(ctx: Context): void {
  ctx.model.extend("mio.log_entry", {
    id: "unsigned",
    groupId: "string(63)",
    segment: "unsigned",
    role: "string(15)",
    content: "json",
    toolCalls: { type: "json", nullable: true },
    toolCallId: { type: "string", length: 63, nullable: true },
    reasoning: { type: "text", nullable: true },
    lastSeq: { type: "unsigned", nullable: true },
    tokens: "unsigned",
    createdAt: "unsigned(8)",
  }, {
    autoInc: true,
    primary: "id",
  });
}

export type ChatMessage =
  | { role: "user"; content: string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; reasoning_content?: string }
  | { role: "tool"; tool_call_id: string; content: string };

export interface NewLogEntry {
  role: LogRole;
  content: LogPart[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  reasoning?: string | null;
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

function partsTokens(parts: LogPart[]): number {
  return parts.reduce((sum, p) => sum + (p.type === "text" ? estimateTokens(p.text) : IMAGE_TOKENS), 0);
}

export class AgentLog {
  private chains = new Map<string, Promise<unknown>>();

  constructor(
    private ctx: Context,
    private aliases: AliasRegistry,
    private options: {
      botName: string;
      mediaDir: string;
      maxBatchEvents: number;
      /** 给每批附上旁注（记忆的浮现）；在别名分配之后调用 */
      annotate?: (groupId: string, events: MioEventRow[]) => Promise<string[]>;
      groupName?: (groupId: string) => Promise<string | undefined>;
    },
  ) {}

  private serial<T>(groupId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(groupId) ?? Promise.resolve();
    const task = previous.then(run);
    this.chains.set(groupId, task.catch(() => {}));
    return task;
  }

  async currentSegment(groupId: string): Promise<number> {
    const max = await this.ctx.database.eval("mio.log_entry", (row) => $.max(row.segment), { groupId });
    return max ?? 1;
  }

  private async lastSeq(groupId: string): Promise<number> {
    const max = await this.ctx.database.eval("mio.log_entry", (row) => $.max(row.lastSeq), { groupId });
    return max ?? 0;
  }

  /** 把上一批之后的新事件渲染成一条 user 条目追加进 log；没有新事件时返回 null */
  appendPendingBatch(groupId: string): Promise<MioLogEntryRow | null> {
    return this.serial(groupId, async () => {
      const after = await this.lastSeq(groupId);
      const pending = await this.ctx.database.get("mio.event", { groupId, seq: { $gt: after } }, { sort: { seq: "asc" } });
      if (pending.length === 0) return null;

      const skipped = Math.max(0, pending.length - this.options.maxBatchEvents);
      const events = pending.slice(skipped) as MioEventRow[];
      const content = await this.render(groupId, events, { skipped, annotate: true });
      return this.create(groupId, { role: "user", content }, events[events.length - 1].seq);
    });
  }

  /**
   * 开新的一段 log（压缩）：第一条是 preamble（群速写、交接）加最近 tailEvents 条消息原文。
   * lastSeq 沿用上一段，之后的批次从这里接着往下，不重复也不遗漏。
   */
  startSegment(groupId: string, preamble: string, tailEvents: number): Promise<MioLogEntryRow> {
    return this.serial(groupId, async () => {
      const segment = (await this.currentSegment(groupId)) + 1;
      const after = await this.lastSeq(groupId);
      const tail = (await this.ctx.database.get("mio.event", { groupId, seq: { $lte: after } }, { sort: { seq: "desc" }, limit: tailEvents })).reverse() as MioEventRow[];

      let content: LogPart[] = [{ type: "text", text: preamble }];
      if (tail.length > 0) {
        const [first, ...rest] = await this.render(groupId, tail, { skipped: 0, annotate: false });
        content = [{ type: "text", text: `${preamble}\n\n〔睡前最后看到的消息〕\n${(first as { text: string }).text}` }, ...rest];
      }
      return this.create(groupId, { role: "user", content }, after, segment);
    });
  }

  private async render(groupId: string, events: MioEventRow[], options: { skipped: number; annotate: boolean }): Promise<LogPart[]> {
    const aliases = new Map<string, string>();
    const names = new Map<string, string>();
    const referenced = new Set<string>();
    for (const event of events) {
      if (event.kind === "recall") {
        referenced.add((event.body as { recalledMessageId: string }).recalledMessageId);
        continue;
      }
      const msg = event.body as NormalizedMessage;
      if (!msg.isBot) aliases.set(msg.senderId, await this.aliases.aliasOf(groupId, msg.senderId, msg.sender));
      for (const m of msg.mentions) {
        if (m.isBot) continue;
        const known = m.displayName !== m.userId ? m.displayName : undefined;
        aliases.set(m.userId, await this.aliases.aliasOf(groupId, m.userId, known));
        const name = await this.aliases.nameOf(groupId, m.userId);
        if (name) names.set(m.userId, name);
      }
      if (msg.replyTo) referenced.add(msg.replyTo.messageId);
    }

    const seqByMessageId = new Map<string, number>();
    if (referenced.size > 0) {
      const rows = await this.ctx.database.get("mio.event", { groupId, platformMessageId: { $in: [...referenced] } }, ["platformMessageId", "seq"]);
      for (const row of rows) seqByMessageId.set(row.platformMessageId, row.seq);
    }

    const annotations = options.annotate && this.options.annotate ? await this.options.annotate(groupId, events) : [];
    const groupName = await this.options.groupName?.(groupId);
    return renderBatch(events, { aliases, names, seqByMessageId, botName: this.options.botName, groupName, skipped: options.skipped, annotations });
  }

  /** 追加 assistant / tool 条目（agent 循环使用） */
  appendEntry(groupId: string, entry: NewLogEntry): Promise<MioLogEntryRow> {
    return this.serial(groupId, () => this.create(groupId, entry, null));
  }

  /**
   * 进程在工具执行途中重启时，最后一条 assistant 的 tool_calls 会缺结果，之后每次请求都会被接口拒绝。
   * 唤醒前给缺的调用补上"中断了"的结果，返回补了几条。缺结果的调用后面已经接了别的条目时，
   * 说明 log 的顺序已经乱了，补不了，直接报错。
   */
  closeInterruptedCalls(groupId: string): Promise<number> {
    return this.serial(groupId, async () => {
      const entries = await this.entries(groupId);
      let last = entries.length - 1;
      while (last >= 0 && !(entries[last].role === "assistant" && entries[last].toolCalls)) last--;
      if (last < 0) return 0;
      const after = entries.slice(last + 1);
      const answered = new Set(after.filter((e) => e.role === "tool").map((e) => e.toolCallId));
      const missing = entries[last].toolCalls!.filter((call) => !answered.has(call.id));
      if (missing.length === 0) return 0;
      if (after.some((e) => e.role !== "tool")) {
        throw new Error(`log entry ${entries[last].id}: tool calls ${missing.map((c) => c.id).join(", ")} have no results and later entries follow`);
      }
      for (const call of missing) {
        await this.create(groupId, {
          role: "tool",
          content: [{ type: "text", text: "（这一步没有结果：执行途中程序重启了，不确定有没有生效）" }],
          toolCallId: call.id,
        }, null);
      }
      return missing.length;
    });
  }

  private async create(groupId: string, entry: NewLogEntry, lastSeq: number | null, segment?: number): Promise<MioLogEntryRow> {
    const toolCallTokens = entry.toolCalls ? estimateTokens(JSON.stringify(entry.toolCalls)) : 0;
    return this.ctx.database.create("mio.log_entry", {
      groupId,
      segment: segment ?? (await this.currentSegment(groupId)),
      role: entry.role,
      content: entry.content,
      toolCalls: entry.toolCalls ?? null,
      toolCallId: entry.toolCallId ?? null,
      reasoning: entry.reasoning ?? null,
      lastSeq,
      tokens: partsTokens(entry.content) + toolCallTokens + (entry.reasoning ? estimateTokens(entry.reasoning) : 0),
      createdAt: Date.now(),
    });
  }

  async entries(groupId: string): Promise<MioLogEntryRow[]> {
    const segment = await this.currentSegment(groupId);
    return this.ctx.database.get("mio.log_entry", { groupId, segment }, { sort: { id: "asc" } });
  }

  async tokenCount(groupId: string): Promise<number> {
    const segment = await this.currentSegment(groupId);
    const sum = await this.ctx.database.eval("mio.log_entry", (row) => $.sum(row.tokens), { groupId, segment });
    return sum ?? 0;
  }

  private async imageUrl(file: string): Promise<string> {
    const mime = MIME[extname(file)];
    if (!mime) throw new Error(`unsupported media type for ${file}`);
    const data = await readFile(join(this.options.mediaDir, file));
    return `data:${mime};base64,${data.toString("base64")}`;
  }

  /** 转成 OpenAI 兼容的消息；文本-only 的 user 条目用字符串，保证同一条目每次序列化结果相同 */
  async toChatMessages(entries: MioLogEntryRow[]): Promise<ChatMessage[]> {
    const messages: ChatMessage[] = [];
    for (const e of entries) {
      const text = e.content.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("\n");
      if (e.role === "tool") {
        if (!e.toolCallId) throw new Error(`log entry ${e.id}: tool result without toolCallId`);
        messages.push({ role: "tool", tool_call_id: e.toolCallId, content: text });
      } else if (e.role === "assistant") {
        messages.push({
          role: "assistant",
          content: text || null,
          ...(e.toolCalls ? { tool_calls: e.toolCalls } : {}),
          ...(e.reasoning ? { reasoning_content: e.reasoning } : {}),
        });
      } else if (e.content.every((p) => p.type === "text")) {
        messages.push({ role: "user", content: text });
      } else {
        const parts = [];
        for (const p of e.content) {
          parts.push(p.type === "text" ? { type: "text" as const, text: p.text } : { type: "image_url" as const, image_url: { url: await this.imageUrl(p.file) } });
        }
        messages.push({ role: "user", content: parts });
      }
    }
    return messages;
  }
}

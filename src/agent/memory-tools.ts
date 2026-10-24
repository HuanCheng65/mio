import { $, Context } from "koishi";
import { join } from "node:path";
import type { ImageSegment, NormalizedMessage } from "../perception/types";
import type { AliasRegistry } from "./aliases";
import type { EventStore } from "./event-store";
import type { MioNoteRow, NoteKind, NoteStore } from "./notes";
import type { StickerFinder } from "./outward-tools";
import type { AgentTool, ToolContext } from "./tools";

const KIND_NAMES: Record<NoteKind, string> = {
  fact: "事实",
  impression: "印象",
  event: "事件",
  self: "自己",
  sticker: "表情包",
};
const KIND_BY_NAME = Object.fromEntries(Object.entries(KIND_NAMES).map(([k, v]) => [v, k])) as Record<string, NoteKind>;

const RECALL_LIMIT = 5;
const RECALL_MIN_SCORE = 0.35;
const STICKER_MIN_SCORE = 0.45;

export interface MemoryDeps {
  ctx: Context;
  notes: NoteStore;
  aliases: AliasRegistry;
  events: EventStore;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const day = (ts: number) => {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function ago(ts: number, now = Date.now()): string {
  const hours = (now - ts) / 3600_000;
  if (hours < 1) return "不到一小时前";
  if (hours < 24) return `${Math.floor(hours)} 小时前`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days} 天前` : `${Math.floor(days / 30)} 个月前`;
}

/** #a3 / a3 / @#a3 / 群 / 我 / 昵称 → about 字段；认不出返回 null */
async function resolveAbout(deps: MemoryDeps, groupId: string, raw: unknown): Promise<string | null> {
  const value = String(raw ?? "").trim();
  if (["群", "群里", "group"].includes(value)) return "group";
  if (["我", "自己", "me"].includes(value)) return "me";
  const alias = /^@?#?(a\d+)$/.exec(value)?.[1] ?? /#(a\d+)$/.exec(value)?.[1];
  if (alias) return (await deps.aliases.userOf(groupId, alias)) ?? null;
  return (await deps.aliases.findByName(groupId, value)) ?? null;
}

async function aboutLabel(deps: MemoryDeps, groupId: string, about: string): Promise<string> {
  if (about === "group") return "群里";
  if (about === "me") return "我";
  const alias = await deps.aliases.aliasOf(groupId, about);
  return `${(await deps.aliases.nameOf(groupId, about)) ?? "某人"}#${alias}`;
}

async function headline(deps: MemoryDeps, groupId: string, note: MioNoteRow): Promise<string> {
  const hidden = note.private ? "（放心里）" : "";
  return `#n${note.id} [${KIND_NAMES[note.kind]}·${await aboutLabel(deps, groupId, note.about)}] ${note.title} (${day(note.updatedAt)})${hidden}`;
}

function parseSeqs(raw: unknown): number[] {
  const text = Array.isArray(raw) ? raw.join(" ") : String(raw ?? "");
  return [...text.matchAll(/m?(\d+)/g)].map((m) => Number(m[1]));
}

function plainText(msg: NormalizedMessage): string {
  return msg.segments.map((s) => (s.type === "text" ? s.content : s.type === "image" ? "[图]" : "")).join("").trim();
}

export function createRecallTool(deps: MemoryDeps): AgentTool {
  return {
    name: "recall",
    description:
      "翻你的小本本。给 query 时列出相关笔记的标题；给 id 时展开一条，连同出处原话一起看。" +
      "〔你隐约记得〕里出现的、或者对话里提到你可能记过的事，想细想时用。没有线索的事通常不用翻。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "想回忆什么，比如\"小林 考试\"" },
        id: { type: "string", description: "要展开的笔记编号，如 n12" },
        about: { type: "string", description: "可选，只看关于某人的（#别名）、群里的（群）或关于自己的（我）" },
      },
    },
    async run(args, ctx: ToolContext) {
      if (args.id !== undefined && args.id !== "") {
        const id = Number(/(\d+)/.exec(String(args.id))?.[1]);
        const note = await deps.notes.open(ctx.groupId, id);
        if (!note) return `本子里没有 n${args.id}`;
        const lines = [await headline(deps, ctx.groupId, note), note.content];
        if (note.createdAt !== note.updatedAt) lines.push(`记于 ${day(note.createdAt)}，改过 ${day(note.updatedAt)}`);
        if (note.private) lines.push("这条放在心里：对方不提，你就别主动提。");
        for (const seq of note.sources.slice(0, 3)) {
          const event = await deps.events.get(ctx.groupId, seq);
          if (event?.kind === "message") lines.push(`出处 [m${seq}] ${(event.body as NormalizedMessage).sender}: ${plainText(event.body as NormalizedMessage)}`);
        }
        return lines.join("\n");
      }

      const query = String(args.query ?? "").trim();
      if (!query) return "要给 query 或 id";
      let about: string | undefined;
      if (args.about !== undefined && args.about !== "") {
        const resolved = await resolveAbout(deps, ctx.groupId, args.about);
        if (!resolved) return `不知道 ${args.about} 是谁，用 #别名 试试`;
        about = resolved;
      }
      const found = await deps.notes.search(ctx.groupId, query, {
        kinds: ["fact", "impression", "event", "self"],
        about,
        limit: RECALL_LIMIT,
        minScore: RECALL_MIN_SCORE,
      });
      if (found.length === 0) return "本子里没找到相关的";
      return (await Promise.all(found.map((f) => headline(deps, ctx.groupId, f.note)))).join("\n");
    },
  };
}

export function createPersonTool(deps: MemoryDeps): AgentTool {
  return {
    name: "person",
    description: "想起某个人：你对 ta 的印象、记过 ta 的哪些事、ta 在群里多活跃。用 #别名 或昵称指人。",
    parameters: {
      type: "object",
      properties: { who: { type: "string", description: "#别名（如 #a3）或昵称" } },
      required: ["who"],
    },
    async run(args, ctx) {
      const userId = await resolveAbout(deps, ctx.groupId, args.who);
      if (!userId || userId === "group" || userId === "me") return `不知道 ${args.who} 是谁，用 #别名 试试`;

      const label = await aboutLabel(deps, ctx.groupId, userId);
      const [count, first, last] = await Promise.all([
        deps.ctx.database.eval("mio.event", (r) => $.count(r.id), { groupId: ctx.groupId, userId, kind: "message" }),
        deps.ctx.database.eval("mio.event", (r) => $.min(r.timestamp), { groupId: ctx.groupId, userId, kind: "message" }),
        deps.ctx.database.eval("mio.event", (r) => $.max(r.timestamp), { groupId: ctx.groupId, userId, kind: "message" }),
      ]);
      const lines = [count > 0 ? `${label}：你见过 ta 说了 ${count} 句话，最早 ${day(first!)}，最近一次 ${ago(last!)}` : `${label}：还没见过 ta 说话`];

      const notes = await deps.notes.about(ctx.groupId, userId);
      const impressions = notes.filter((n) => n.kind === "impression");
      const others = notes.filter((n) => n.kind !== "impression" && n.kind !== "sticker");
      for (const n of impressions) lines.push(`印象 #n${n.id}：${n.content}${n.private ? "（放心里）" : ""}`);
      if (others.length > 0) {
        lines.push("记过的事：");
        for (const n of others.slice(0, 10)) lines.push(`  ${await headline(deps, ctx.groupId, n)}`);
      }
      if (notes.length === 0) lines.push("本子里还没记过 ta 什么");
      return lines.join("\n");
    },
  };
}

export function createRememberTool(deps: MemoryDeps): AgentTool {
  return {
    name: "remember",
    description:
      "在小本本上记一笔。值得记的：和某个人有关的事（在忙什么、喜欢什么、怎么称呼 ta）、让人印象深的事、" +
      "群里的梗、你自己说过的观点或答应过的事。寒暄、刷屏不用记。" +
      "用你自己的口吻写，可以带不确定（\"好像\"\"应该\"）。写上出处的消息编号。" +
      "要是本子里已经有这件事、现在有了变化，用 update 改写那一条，把前后变化写在一起。" +
      "别人在难受时说的话，记下来但标 private：对方不提你就不提。" +
      "收藏表情包：kind 填表情包，message 填图所在的消息，title 写它适合表达的感觉。",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: Object.values(KIND_NAMES), description: "这一笔是什么" },
        about: { type: "string", description: "关于谁：#别名、群、我" },
        title: { type: "string", description: "一句话标题，以后靠它想起来" },
        content: { type: "string", description: "具体内容，第一人称，一两句话" },
        sources: { type: "string", description: "出处的消息编号，如 \"m120 m123\"" },
        private: { type: "boolean", description: "放在心里，对方不提就不主动提" },
        update: { type: "string", description: "改写已有笔记时填它的编号，如 n12" },
        message: { type: "string", description: "收藏表情包时：图所在的消息编号" },
        image: { type: "number", description: "收藏表情包时：这条消息里的第几张图，从 1 开始，默认第 1 张" },
      },
      required: ["kind", "title"],
    },
    async run(args, ctx) {
      const title = String(args.title ?? "").trim();
      const content = String(args.content ?? "").trim();
      if (!title) return "要有一句话标题";
      const sources = parseSeqs(args.sources);

      if (args.update !== undefined && args.update !== "") {
        const id = Number(/(\d+)/.exec(String(args.update))?.[1]);
        const updated = await deps.notes.rewrite(ctx.groupId, id, {
          title,
          content: content || title,
          sources,
          ...(args.private === undefined ? {} : { private: Boolean(args.private) }),
        });
        return updated ? `改好了 #n${id}` : `本子里没有 n${args.update}`;
      }

      const kind = KIND_BY_NAME[String(args.kind)];
      if (!kind) return `kind 只能是：${Object.values(KIND_NAMES).join("、")}`;

      let file: string | null = null;
      let about: string | null;
      if (kind === "sticker") {
        const seq = parseSeqs(args.message)[0];
        if (seq === undefined) return "收藏表情包要填 message";
        const event = await deps.events.get(ctx.groupId, seq);
        if (!event || event.kind !== "message") return `找不到 m${seq}`;
        const images = (event.body as NormalizedMessage).segments.filter((s): s is ImageSegment => s.type === "image");
        const image = images[(args.image === undefined ? 1 : Number(args.image)) - 1];
        if (!image) return `m${seq} 里没有那张图`;
        if (!image.file) return "那张图当时没能保存下来，收藏不了";
        file = image.file;
        about = "me";
        sources.push(seq);
      } else {
        about = await resolveAbout(deps, ctx.groupId, args.about);
        if (!about) return `不知道 ${args.about ?? "（没填）"} 是谁。about 填 #别名、群 或 我`;
      }

      const note = { kind, about, title, content: content || title, sources, private: Boolean(args.private), file };
      const vector = await deps.notes.embed(note);
      const duplicate = await deps.notes.findDuplicate(ctx.groupId, note, vector);
      if (duplicate) {
        return `本子里已经有一条很像的：${await headline(deps, ctx.groupId, duplicate)}：${duplicate.content}\n` +
          `是同一件事有了变化，就用 update=n${duplicate.id} 改写；确实是另一件事，就写得更具体些。这次没记`;
      }
      const created = await deps.notes.create(ctx.groupId, note, vector);
      return `记下了 #n${created.id}`;
    },
  };
}

/** 按感觉在她收藏的表情包里找（收藏是她自己的，不分群） */
export function createStickerFinder(ctx: Context, notes: NoteStore, mediaDir: string): StickerFinder {
  return {
    async find(feeling) {
      const groups = await ctx.database.select("mio.note").where({ kind: "sticker" }).execute((r) => $.array(r.groupId));
      let best: { note: MioNoteRow; score: number } | null = null;
      for (const groupId of new Set(groups)) {
        const [top] = await notes.search(groupId, feeling, { kinds: ["sticker"], limit: 1, minScore: STICKER_MIN_SCORE });
        if (top && (!best || top.score > best.score)) best = top;
      }
      if (!best?.note.file) return null;
      return { path: join(mediaDir, best.note.file), description: best.note.title };
    },
  };
}

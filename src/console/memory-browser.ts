import { $, Context } from "koishi";
import type { BanBody, MioEventRow, MuteBody, ReactionBody, RecallBody } from "../agent/event-store";
import type { NoteKind } from "../agent/notes";
import type { GroupNames } from "../agent/group-names";
import type { NormalizedMessage } from "../perception/types";
import type { GroupRegistry, MioGroupMode } from "../runtime/groups";

export interface MemoryGroup {
  groupId: string;
  name: string | null;
  mode: MioGroupMode;
  notes: number;
}

export interface MemoryNote {
  id: number;
  kind: NoteKind;
  /** 平台用户 ID、"group" 或 "me" */
  about: string;
  /** 给人看的：昵称#别名、群、自己 */
  aboutLabel: string;
  title: string;
  content: string;
  sources: number[];
  private: boolean;
  file: string | null;
  recallCount: number;
  lastRecalledAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemorySource {
  seq: number;
  timestamp: number;
  sender: string;
  text: string;
}

export interface MemorySegment {
  segment: number;
  startedAt: number;
  tokens: number;
  /** 睡前整理写下的群速写和交接；第一段没有 */
  summary: string | null;
}

declare module "@koishijs/plugin-console" {
  interface Events {
    "mio/memory-groups"(): Promise<MemoryGroup[]>;
    "mio/memory-notes"(groupId: string): Promise<MemoryNote[]>;
    "mio/memory-sources"(groupId: string, seqs: number[]): Promise<MemorySource[]>;
    "mio/memory-segments"(groupId: string): Promise<MemorySegment[]>;
  }
}

/** startSegment 把睡前最后看到的消息接在交接后面，浏览时只看整理写下的部分 */
const TAIL_MARKER = "\n\n〔睡前最后看到的消息〕";

function plainText(msg: NormalizedMessage): string {
  return msg.segments.map((s) => {
    switch (s.type) {
      case "text": return s.content;
      case "image": return s.isSticker ? "[表情包]" : "[图]";
      case "face": return `[表情:${s.name}]`;
      case "share": return `[分享：${s.title}]`;
      case "forward": return `[${s.summary}]`;
      case "poke": return `[${s.action} ${s.target}]`;
      case "unsupported": return s.hint;
    }
  }).join("").trim();
}

function describeEvent(event: MioEventRow): Pick<MemorySource, "sender" | "text"> {
  switch (event.kind) {
    case "message": {
      const msg = event.body as NormalizedMessage;
      return { sender: msg.isBot ? "澪" : msg.sender, text: plainText(msg) };
    }
    case "recall":
      return { sender: (event.body as RecallBody).recalledBy || "有人", text: "（撤回了一条消息）" };
    case "ban": {
      const ban = event.body as BanBody;
      return { sender: ban.operatorId, text: ban.lift ? "（解除禁言）" : "（禁言）" };
    }
    case "reaction": {
      const reaction = event.body as ReactionBody;
      return { sender: reaction.userId, text: `（贴了 [表情:${reaction.emoji}]）` };
    }
    case "mute":
      return { sender: "管理", text: (event.body as MuteBody).muted ? "（静音）" : "（解除静音）" };
  }
}

/** 只读的记忆浏览查询：澪的笔记、笔记出处、睡前整理的段落摘要。只依赖数据库，不需要运行时启动 */
export function createMemoryQueries(ctx: Context, groups: GroupRegistry, groupNames: Pick<GroupNames, "get">) {
  return {
    async groups(): Promise<MemoryGroup[]> {
      const counts = await ctx.database.select("mio.note").groupBy("groupId", { notes: (row) => $.count(row.id) }).execute();
      const byGroup = new Map(counts.map((c) => [c.groupId, c.notes]));
      const groupIds = [...new Set([...groups.list(), ...byGroup.keys()])].sort();
      return Promise.all(groupIds.map(async (groupId) => ({
        groupId,
        name: (await groupNames.get(groupId)) ?? null,
        mode: groups.getMode(groupId),
        notes: byGroup.get(groupId) ?? 0,
      })));
    },

    async notes(groupId: string): Promise<MemoryNote[]> {
      const [notes, aliases] = await Promise.all([
        ctx.database.get("mio.note", { groupId }, { sort: { updatedAt: "desc" }, fields: ["id", "kind", "about", "title", "content", "sources", "private", "file", "recallCount", "lastRecalledAt", "createdAt", "updatedAt"] }),
        ctx.database.get("mio.alias", { groupId }),
      ]);
      const people = new Map(aliases.map((a) => [a.userId, `${a.name ?? "某人"}#${a.alias}`]));
      return notes.map((note) => ({
        ...note,
        aboutLabel: note.about === "group" ? "群" : note.about === "me" ? "自己" : people.get(note.about) ?? note.about,
      }));
    },

    async sources(groupId: string, seqs: number[]): Promise<MemorySource[]> {
      const events = await ctx.database.get("mio.event", { groupId, seq: { $in: seqs } }, { sort: { seq: "asc" } });
      return events.map((event) => ({ seq: event.seq, timestamp: event.timestamp, ...describeEvent(event) }));
    },

    async segments(groupId: string): Promise<MemorySegment[]> {
      const stats = await ctx.database.select("mio.log_entry", { groupId })
        .groupBy("segment", { first: (row) => $.min(row.id), tokens: (row) => $.sum(row.tokens) })
        .execute();
      const firsts = await ctx.database.get("mio.log_entry", { id: { $in: stats.map((s) => s.first) } }, ["id", "content", "createdAt"]);
      const firstById = new Map(firsts.map((f) => [f.id, f]));
      return stats.map(({ segment, first, tokens }) => {
        const entry = firstById.get(first)!;
        const text = entry.content[0]?.type === "text" ? entry.content[0].text : "";
        // 只有睡前整理开的段才以群速写开头；第一段从群聊本身开始
        const summary = text.startsWith("〔群速写〕") ? text.split(TAIL_MARKER)[0] : null;
        return { segment, startedAt: entry.createdAt, tokens, summary };
      }).sort((a, b) => b.segment - a.segment);
    },
  };
}

export function registerMemoryBrowser(ctx: Context, groups: GroupRegistry, groupNames: GroupNames): void {
  const queries = createMemoryQueries(ctx, groups, groupNames);
  ctx.inject(["console"], (ctx) => {
    ctx.console.addListener("mio/memory-groups", () => queries.groups());
    ctx.console.addListener("mio/memory-notes", (groupId) => queries.notes(groupId));
    ctx.console.addListener("mio/memory-sources", (groupId, seqs) => queries.sources(groupId, seqs));
    ctx.console.addListener("mio/memory-segments", (groupId) => queries.segments(groupId));
  });
}

import { $, Context } from "koishi";
import type { NormalizedMessage } from "../perception/types";
import type { AliasRegistry } from "./aliases";
import type { MioEventRow } from "./event-store";
import { ago, day } from "./memory-tools";
import type { NoteStore } from "./notes";

export interface RecollectionOptions {
  /** 每批最多浮现几条记忆 */
  hintLimit: number;
  /** 相关度低于这个的不浮现 */
  hintMinScore: number;
}

/**
 * 记忆的"浮现"：每批消息追加进 log 时，在末尾附上
 * - 人物卡片：某人在这一段 log 里第一次说话时，附上本子里关于 ta 的概况
 * - 隐约记得：和这批消息相关的笔记标题（不给内容，想细想再 recall）
 * 只给线索，让模型知道"有这段记忆"，要不要展开由她决定。
 *
 * 哪些人、哪些笔记在这一段里出现过，只记在内存里：重启或压缩后会再出现一次，
 * 只是多几行线索，不影响正确性。
 */
export class Recollection {
  private carded = new Map<string, Set<string>>();
  private hinted = new Map<string, Set<number>>();

  constructor(
    private ctx: Context,
    private notes: NoteStore,
    private aliases: AliasRegistry,
    private options: RecollectionOptions,
  ) {}

  /** 开新一段 log（压缩）时调用 */
  resetSegment(groupId: string): void {
    this.carded.delete(groupId);
    this.hinted.delete(groupId);
  }

  async annotate(groupId: string, events: MioEventRow[]): Promise<string[]> {
    const lines: string[] = [];
    const carded = this.carded.get(groupId) ?? new Set<string>();
    this.carded.set(groupId, carded);

    const texts: string[] = [];
    for (const event of events) {
      if (event.kind !== "message") continue;
      const msg = event.body as NormalizedMessage;
      if (msg.isBot) continue;
      texts.push(msg.segments.map((s) => (s.type === "text" ? s.content : "")).join(""));
      if (carded.has(msg.senderId)) continue;
      carded.add(msg.senderId);
      const card = await this.card(groupId, msg.senderId, event.seq);
      if (card) lines.push(card);
    }

    const text = texts.join("\n").trim();
    if (text) {
      const hinted = this.hinted.get(groupId) ?? new Set<number>();
      this.hinted.set(groupId, hinted);
      const found = await this.notes.search(groupId, text, {
        kinds: ["fact", "impression", "event", "self"],
        limit: this.options.hintLimit * 3,
        minScore: this.options.hintMinScore,
      });
      const fresh = found.filter((f) => !hinted.has(f.note.id)).slice(0, this.options.hintLimit);
      for (const f of fresh) hinted.add(f.note.id);
      if (fresh.length > 0) {
        const titles = fresh.map((f) => `「${f.note.title}」(${day(f.note.updatedAt)})${f.note.private ? "（放心里）" : ""}`);
        lines.push(`〔你隐约记得〕${titles.join(" ")}`);
      }
    }
    return lines;
  }

  private async card(groupId: string, userId: string, seq: number): Promise<string | null> {
    const label = `${(await this.aliases.nameOf(groupId, userId)) ?? "某人"}#${await this.aliases.aliasOf(groupId, userId)}`;
    const lastBefore = await this.ctx.database.eval("mio.event", (r) => $.max(r.timestamp), {
      groupId,
      userId,
      kind: "message",
      seq: { $lt: seq },
    });
    if (!lastBefore) return `〔第一次见到 ${label} 说话〕`;

    const notes = (await this.notes.about(groupId, userId)).filter((n) => n.kind !== "sticker");
    if (notes.length === 0) return null;
    const parts = [`记过 ${notes.length} 件事`, `上次说话 ${ago(lastBefore)}`];
    const impression = notes.find((n) => n.kind === "impression");
    if (impression) parts.push(`印象：${impression.title}`);
    return `〔${label}：${parts.join(" · ")}〕`;
  }
}

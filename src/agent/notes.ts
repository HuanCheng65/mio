import { Context, type Query } from "koishi";
import { cosineSimilarity, EmbeddingService } from "../memory/embedding";

/**
 * 澪的小本本：她自己写的第一人称笔记。
 * - about：平台用户 ID，或 "group"（群里的事 / 梗）、"me"（关于她自己：说过的话、表过的态、答应的事、最近在意的东西）
 * - sources：出处的消息编号，回想时可以核对原话，避免凭空"记得"
 * - private：放在心里，对方不提就不主动提
 * 矛盾不打标记：她改写原笔记，把前后变化写成一段话。
 */
export type NoteKind = "fact" | "impression" | "event" | "self" | "sticker";

export interface MioNoteRow {
  id: number;
  groupId: string;
  kind: NoteKind;
  about: string;
  title: string;
  content: string;
  sources: number[];
  private: boolean;
  /** 表情包收藏：存在 data/mio/media 下的文件名 */
  file: string | null;
  embedding: number[];
  recallCount: number;
  lastRecalledAt: number | null;
  createdAt: number;
  updatedAt: number;
}

declare module "koishi" {
  interface Tables {
    "mio.note": MioNoteRow;
  }
}

export function extendNoteTable(ctx: Context): void {
  ctx.model.extend("mio.note", {
    id: "unsigned",
    groupId: "string(63)",
    kind: "string(15)",
    about: "string(127)",
    title: "string(255)",
    content: "text",
    sources: { type: "json", initial: [] },
    private: { type: "boolean", initial: false },
    file: { type: "string", length: 127, nullable: true },
    embedding: { type: "json", initial: [] },
    recallCount: { type: "unsigned", initial: 0 },
    lastRecalledAt: { type: "unsigned", length: 8, nullable: true },
    createdAt: "unsigned(8)",
    updatedAt: "unsigned(8)",
  }, {
    autoInc: true,
    primary: "id",
  });
}

export const NOTE_EMBEDDING_KEY = "note.embeddingModel";

export interface NewNote {
  kind: NoteKind;
  about: string;
  title: string;
  content: string;
  sources: number[];
  private: boolean;
  file?: string | null;
}

export interface ScoredNote {
  note: MioNoteRow;
  score: number;
}

const DUPLICATE_SIMILARITY = 0.9;

const embedText = (n: { title: string; content: string }) => `${n.title}\n${n.content}`;

export class NoteStore {
  constructor(private ctx: Context, private embedding: EmbeddingService) {}

  async embed(note: Pick<NewNote, "title" | "content">): Promise<number[]> {
    const [vector] = await this.embedding.embedBatch([embedText(note)]);
    return vector;
  }

  /** 写入前先找很像的笔记：有就不写，交给她决定是不是改写那条 */
  async findDuplicate(groupId: string, note: NewNote, vector: number[]): Promise<MioNoteRow | null> {
    const candidates = await this.ctx.database.get("mio.note", { groupId, kind: note.kind, about: note.about });
    let best: ScoredNote | null = null;
    for (const c of candidates) {
      const score = cosineSimilarity(vector, c.embedding);
      if (score >= DUPLICATE_SIMILARITY && (!best || score > best.score)) best = { note: c, score };
    }
    return best?.note ?? null;
  }

  async create(groupId: string, note: NewNote, vector: number[]): Promise<MioNoteRow> {
    const now = Date.now();
    return this.ctx.database.create("mio.note", {
      groupId,
      ...note,
      file: note.file ?? null,
      embedding: vector,
      recallCount: 0,
      lastRecalledAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** 改写一条笔记（时间线式：新内容应包含前后的变化） */
  async rewrite(groupId: string, id: number, change: Pick<NewNote, "title" | "content"> & Partial<Pick<NewNote, "sources" | "private">>): Promise<MioNoteRow | null> {
    const existing = await this.get(groupId, id);
    if (!existing) return null;
    const vector = await this.embed(change);
    const updated = {
      title: change.title,
      content: change.content,
      sources: [...new Set([...existing.sources, ...(change.sources ?? [])])],
      private: change.private ?? existing.private,
      embedding: vector,
      updatedAt: Date.now(),
    };
    await this.ctx.database.set("mio.note", { id }, updated);
    return { ...existing, ...updated };
  }

  async get(groupId: string, id: number): Promise<MioNoteRow | null> {
    const [row] = await this.ctx.database.get("mio.note", { id, groupId });
    return row ?? null;
  }

  /** 主动回想时调用：展开一条并记一次"被想起" */
  async open(groupId: string, id: number): Promise<MioNoteRow | null> {
    const row = await this.get(groupId, id);
    if (!row) return null;
    const recalled = { recallCount: row.recallCount + 1, lastRecalledAt: Date.now() };
    await this.ctx.database.set("mio.note", { id }, recalled);
    return { ...row, ...recalled };
  }

  /** 按语义检索；kinds / about 用来缩小范围 */
  async search(
    groupId: string,
    query: string,
    options: { kinds?: NoteKind[]; about?: string; limit: number; minScore: number },
  ): Promise<ScoredNote[]> {
    const filter: Query.Expr<MioNoteRow> = { groupId };
    // minato 把联合类型拆开推断，NoteKind[] 对不上任何单个字面量数组
    if (options.kinds) filter.kind = { $in: options.kinds } as Query.Expr<MioNoteRow>["kind"];
    if (options.about) filter.about = options.about;
    const rows = await this.ctx.database.get("mio.note", filter);
    if (rows.length === 0) return [];
    const [vector] = await this.embedding.embedBatch([query]);
    return rows
      .map((note) => ({ note, score: cosineSimilarity(vector, note.embedding) }))
      .filter((s) => s.score >= options.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, options.limit);
  }

  async about(groupId: string, about: string): Promise<MioNoteRow[]> {
    return this.ctx.database.get("mio.note", { groupId, about }, { sort: { updatedAt: "desc" } });
  }
}

import { $, Context } from "koishi";
import type { NormalizedMessage } from "../perception/types";

/**
 * 群事件流：新运行时的事实来源。每个群一个自增 seq，渲染时就是 [m{seq}]，永不重排。
 * body 存完整的 normalize 结果，渲染方式以后可以变，原始事件不变。
 */
export type MioEventKind = "message" | "recall";

export interface MioEventRow {
  id: number;
  groupId: string;
  seq: number;
  kind: MioEventKind;
  platformMessageId: string;
  userId: string;
  isBot: boolean;
  timestamp: number;
  body: NormalizedMessage | { recalledMessageId: string; recalledBy: string };
}

declare module "koishi" {
  interface Tables {
    "mio.event": MioEventRow;
  }
}

export function extendEventTable(ctx: Context): void {
  ctx.model.extend("mio.event", {
    id: "unsigned",
    groupId: "string(63)",
    seq: "unsigned",
    kind: "string(15)",
    platformMessageId: "string(127)",
    userId: "string(127)",
    isBot: "boolean",
    timestamp: "unsigned(8)",
    body: "json",
  }, {
    autoInc: true,
    primary: "id",
    unique: [["groupId", "seq"]],
  });
}

export type NewEvent = Omit<MioEventRow, "id" | "groupId" | "seq">;

export class EventStore {
  private nextSeq = new Map<string, number>();
  private chains = new Map<string, Promise<unknown>>();

  constructor(private ctx: Context) {}

  /**
   * 按群串行执行：prepare 里做的事（例如下载图片）完成后才分配 seq 并写入，
   * 保证同一个群的事件按到达顺序编号。
   */
  append(groupId: string, prepare: () => Promise<NewEvent>): Promise<MioEventRow> {
    const previous = this.chains.get(groupId) ?? Promise.resolve();
    const task = previous.then(async () => {
      const event = await prepare();
      const seq = await this.allocateSeq(groupId);
      return this.ctx.database.create("mio.event", { ...event, groupId, seq });
    });
    // 一条失败不能卡住后续事件；失败由调用方的 catch 报告
    this.chains.set(groupId, task.catch(() => {}));
    return task;
  }

  /** 按群内编号取事件（[mN] → 平台消息 ID 等） */
  async get(groupId: string, seq: number): Promise<MioEventRow | undefined> {
    const [row] = await this.ctx.database.get("mio.event", { groupId, seq });
    return row;
  }

  private async allocateSeq(groupId: string): Promise<number> {
    let next = this.nextSeq.get(groupId);
    if (next === undefined) {
      const max = await this.ctx.database.eval("mio.event", (row) => $.max(row.seq), { groupId });
      next = (max ?? 0) + 1;
    }
    this.nextSeq.set(groupId, next + 1);
    return next;
  }
}

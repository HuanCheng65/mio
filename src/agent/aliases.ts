import { Context } from "koishi";

/**
 * 群内短别名：log 里用 `昵称#a3` 指代一个人。平台 ID（官方 QQ 是 32 位 openid）既费 token
 * 又容易认错，短别名在群内永久固定，代码负责和平台 ID 互转。
 */
export interface MioAliasRow {
  groupId: string;
  userId: string;
  alias: string;
  /** 最近一次见到的昵称；被 @ 却还没说过话的人没有 */
  name: string | null;
}

declare module "koishi" {
  interface Tables {
    "mio.alias": MioAliasRow;
  }
}

export function extendAliasTable(ctx: Context): void {
  ctx.model.extend("mio.alias", {
    groupId: "string(63)",
    userId: "string(127)",
    alias: "string(15)",
    name: { type: "string", length: 255, nullable: true },
  }, {
    primary: ["groupId", "userId"],
    unique: [["groupId", "alias"]],
  });
}

interface AliasEntry {
  alias: string;
  name: string | null;
}

export class AliasRegistry {
  private byUser = new Map<string, Map<string, AliasEntry>>();
  private loading = new Map<string, Promise<Map<string, AliasEntry>>>();
  private chains = new Map<string, Promise<unknown>>();

  constructor(private ctx: Context) {}

  private group(groupId: string): Promise<Map<string, AliasEntry>> {
    const cached = this.byUser.get(groupId);
    if (cached) return Promise.resolve(cached);
    let pending = this.loading.get(groupId);
    if (!pending) {
      pending = this.ctx.database.get("mio.alias", { groupId }).then((rows) => {
        const map = new Map(rows.map((r) => [r.userId, { alias: r.alias, name: r.name }]));
        this.byUser.set(groupId, map);
        this.loading.delete(groupId);
        return map;
      });
      this.loading.set(groupId, pending);
    }
    return pending;
  }

  /**
   * 取别名，没有就分配一个；传入 name 时顺带记下这个人最新的昵称。
   * 按群串行，保证编号不重复。
   */
  aliasOf(groupId: string, userId: string, name?: string): Promise<string> {
    const previous = this.chains.get(groupId) ?? Promise.resolve();
    const task = previous.then(async () => {
      const map = await this.group(groupId);
      const existing = map.get(userId);
      if (!existing) {
        const entry = { alias: `a${map.size + 1}`, name: name ?? null };
        await this.ctx.database.create("mio.alias", { groupId, userId, ...entry });
        map.set(userId, entry);
        return entry.alias;
      }
      if (name && name !== existing.name) {
        await this.ctx.database.set("mio.alias", { groupId, userId }, { name });
        existing.name = name;
      }
      return existing.alias;
    });
    this.chains.set(groupId, task.catch(() => {}));
    return task;
  }

  async nameOf(groupId: string, userId: string): Promise<string | null> {
    return (await this.group(groupId)).get(userId)?.name ?? null;
  }

  /** 别名转回平台 ID；未知别名返回 undefined，由调用方决定怎么告诉模型 */
  async userOf(groupId: string, alias: string): Promise<string | undefined> {
    const map = await this.group(groupId);
    for (const [userId, entry] of map) if (entry.alias === alias) return userId;
    return undefined;
  }
}

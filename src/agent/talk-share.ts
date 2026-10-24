import type { Context } from "koishi";
import type { Outbox } from "./outbox";

const WINDOW_MS = 15 * 60_000;
const MIN_OWN = 3;

/**
 * 澪自己的话只以工具调用的形式出现在 log 里，每批只看得到别人新说的一两句，
 * 看不出自己已经占了多大篇幅。最近说得多时附一条旁注；只给数字，开不开口仍由她判断。
 */
export async function talkShareNote(ctx: Context, outbox: Outbox, groupId: string, now = Date.now()): Promise<string | null> {
  const own = outbox.sentSince(groupId, now - WINDOW_MS);
  if (own < MIN_OWN) return null;
  const others = await ctx.database.get("mio.event", { groupId, kind: "message", isBot: false, timestamp: { $gte: now - WINDOW_MS } }, ["id"]);
  return `〔最近 15 分钟：你说了 ${own} 条，其他人 ${others.length} 条〕`;
}

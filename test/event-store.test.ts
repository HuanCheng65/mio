import test from "node:test";
import assert from "node:assert/strict";
import { EventStore, type NewEvent } from "../src/agent/event-store";

function createFakeCtx() {
  const rows: any[] = [];
  const database = {
    async eval(_table: string, _expr: unknown, query: { groupId: string }) {
      const seqs = rows.filter((r) => r.groupId === query.groupId).map((r) => r.seq);
      return seqs.length > 0 ? Math.max(...seqs) : null;
    },
    async create(_table: string, data: any) {
      const row = { id: rows.length + 1, ...data };
      rows.push(row);
      return row;
    },
  };
  return { ctx: { database } as any, rows };
}

const event = (text: string): NewEvent => ({
  kind: "message",
  platformMessageId: text,
  userId: "u",
  isBot: false,
  timestamp: 0,
  body: { recalledMessageId: text, recalledBy: "" },
});

test("EventStore numbers each group's events in arrival order even when preparation is slow", async () => {
  const { ctx, rows } = createFakeCtx();
  const store = new EventStore(ctx);

  const slow = store.append("qq:A", async () => {
    await new Promise((r) => setTimeout(r, 30));
    return event("first");
  });
  const fast = store.append("qq:A", async () => event("second"));
  const other = store.append("qq:B", async () => event("other-group"));
  await Promise.all([slow, fast, other]);

  const a = rows.filter((r) => r.groupId === "qq:A").map((r) => [r.platformMessageId, r.seq]);
  assert.deepEqual(a, [["first", 1], ["second", 2]]);
  assert.equal(rows.find((r) => r.groupId === "qq:B").seq, 1);
});

test("EventStore keeps numbering after a failed append and continues from stored events", async () => {
  const { ctx, rows } = createFakeCtx();
  rows.push({ id: 1, groupId: "qq:A", seq: 41 });
  const store = new EventStore(ctx);

  await assert.rejects(store.append("qq:A", async () => {
    throw new Error("normalize failed");
  }));
  const row = await store.append("qq:A", async () => event("next"));
  assert.equal(row.seq, 42);
});

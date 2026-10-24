import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "koishi";
import sqlite from "@koishijs/plugin-database-sqlite";
import { EventStore, extendEventTable } from "../src/agent/event-store";
import { Outbox } from "../src/agent/outbox";
import { talkShareNote } from "../src/agent/talk-share";

const G = "qq:G";
const MIN = 60_000;

test("tells Mio how much of the recent chat was hers once she has said a few things", async () => {
  const app = new Context();
  app.plugin(sqlite, { path: ":memory:" });
  extendEventTable(app);
  await app.start();
  const events = new EventStore(app);
  const outbox = new Outbox({ minIntervalMs: 0, maxPerHour: 40, maxConsecutive: 99 });
  const now = 100 * MIN;
  const message = (timestamp: number) => events.append(G, async () => ({
    kind: "message", platformMessageId: `p${timestamp}`, userId: "U1", isBot: false, timestamp,
    body: { recalledMessageId: "", recalledBy: "" },
  }));

  await message(now - 20 * MIN);
  await message(now - 5 * MIN);
  await message(now - MIN);
  outbox.recordSent(G, [], now - 20 * MIN);
  outbox.recordSent(G, [], now - 4 * MIN);
  outbox.recordSent(G, [], now - 3 * MIN);
  assert.equal(await talkShareNote(app, outbox, G, now), null, "two recent messages are not worth a note");

  outbox.recordSent(G, [], now - 2 * MIN);
  assert.equal(await talkShareNote(app, outbox, G, now), "〔最近 15 分钟：你说了 3 条，其他人 2 条〕");
  await app.stop();
});

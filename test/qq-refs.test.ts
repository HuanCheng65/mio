import test from "node:test";
import assert from "node:assert/strict";
import { Context, type Session } from "koishi";
import sqlite from "@koishijs/plugin-database-sqlite";
import { EventStore, extendEventTable } from "../src/agent/event-store";
import { extendSentRefTable, resolveQQReply } from "../src/agent/qq-refs";
import { qqRefIndexes } from "../src/platform/qq";
import type { NormalizedMessage } from "../src/perception/types";

const G = "qq:G";

// 形状照真实事件的 message_scene（索引截短，auth_token 换掉）
const scene = (ext: string[]) => ({ event: { _data: { d: { message_scene: { source: "default", ext } } } } }) as unknown as Session;

test("reads a message's own index and the index it quotes from message_scene.ext", () => {
  assert.deepEqual(qqRefIndexes(scene(["ref_msg_idx=REFIDX_e0Vu+a/b=", "msg_idx=REFIDX_eIgP", "auth_token=x"])), {
    own: "REFIDX_eIgP",
    quoted: "REFIDX_e0Vu+a/b=",
  });
  assert.deepEqual(qqRefIndexes(scene(["msg_idx=REFIDX_O6vC"])), { own: "REFIDX_O6vC", quoted: undefined });
  assert.deepEqual(qqRefIndexes({ event: {} } as unknown as Session), {});
});

async function setup() {
  const app = new Context();
  app.plugin(sqlite, { path: ":memory:" });
  extendEventTable(app);
  extendSentRefTable(app);
  await app.start();
  return { app, events: new EventStore(app) };
}

const quoting = (refIdx: string): NormalizedMessage => ({
  id: "q", sender: "小林", senderId: "U2", isBot: false, timestamp: 0, segments: [], mentions: [],
  replyTo: { messageId: "", sender: "某人", preview: "原文", refIdx },
});

test("resolves a QQ quote to the group member's message it points at", async () => {
  const { app, events } = await setup();
  const body: NormalizedMessage = { id: "p1", sender: "白川", senderId: "U1", isBot: false, timestamp: 0, segments: [], mentions: [], refIdx: "R1" };
  await events.append(G, async () => ({ kind: "message", platformMessageId: "p1", userId: "U1", isBot: false, timestamp: 0, body, refIdx: "R1" }));

  const msg = quoting("R1");
  await resolveQQReply(app, events, G, msg, "澪");
  assert.deepEqual(msg.replyTo, { messageId: "p1", sender: "白川", preview: "原文", refIdx: "R1" });
  await app.stop();
});

test("resolves a QQ quote of the bot's own message through the recorded send", async () => {
  const { app, events } = await setup();
  await app.database.create("mio.sent_ref", { groupId: G, refIdx: "R9", messageId: "sent9", createdAt: 0 });

  const msg = quoting("R9");
  await resolveQQReply(app, events, G, msg, "澪");
  assert.deepEqual(msg.replyTo, { messageId: "sent9", sender: "澪", preview: "原文", refIdx: "R9", fromBot: true });

  const elsewhere = quoting("R9");
  await resolveQQReply(app, events, "qq:OTHER", elsewhere, "澪");
  assert.equal(elsewhere.replyTo!.messageId, "", "indexes are looked up within the group");
  await app.stop();
});

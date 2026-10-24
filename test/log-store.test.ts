import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "koishi";
import sqlite from "@koishijs/plugin-database-sqlite";
import { extendEventTable, EventStore } from "../src/agent/event-store";
import { AliasRegistry, extendAliasTable } from "../src/agent/aliases";
import { AgentLog, extendLogTable } from "../src/agent/log-store";
import type { NormalizedMessage } from "../src/perception/types";

const G = "qq:G";

async function setup(maxBatchEvents = 80) {
  const app = new Context();
  app.plugin(sqlite, { path: ":memory:" });
  extendEventTable(app);
  extendAliasTable(app);
  extendLogTable(app);
  await app.start();
  const mediaDir = mkdtempSync(join(tmpdir(), "mio-media-"));
  const events = new EventStore(app);
  const aliases = new AliasRegistry(app);
  const log = new AgentLog(app, aliases, { botName: "澪", mediaDir, maxBatchEvents });

  let n = 0;
  const say = (senderId: string, text: string, extra: Partial<NormalizedMessage> = {}) => {
    const id = `p${++n}`;
    const msg: NormalizedMessage = { id, sender: senderId === "U1" ? "白川" : "Masou", senderId, isBot: false, timestamp: Date.now(), segments: [{ type: "text", content: text }], mentions: [], ...extra };
    return events.append(G, async () => ({ kind: "message", platformMessageId: id, userId: senderId, isBot: false, timestamp: msg.timestamp, body: msg }));
  };
  return { app, log, aliases, say, mediaDir };
}

const textOf = (entry: { content: { type: string; text?: string }[] }) => entry.content[0].text!;

test("appends only events after the previous batch, once, with stable aliases", async () => {
  const { app, log, say } = await setup();
  assert.equal(await log.appendPendingBatch(G), null);

  await say("U1", "早");
  await say("U2", "早上好");
  const [first, raced] = await Promise.all([log.appendPendingBatch(G), log.appendPendingBatch(G)]);
  assert.equal(raced, null, "a concurrent append must not render the same events twice");
  assert.match(textOf(first!), /\[m1\] 白川#a1 .*: 早\n\[m2\] Masou#a2 .*: 早上好$/);
  assert.equal(first!.lastSeq, 2);

  await say("U2", "吃了吗", { replyTo: { messageId: "p1", sender: "白川", preview: "早" } });
  const second = await log.appendPendingBatch(G);
  assert.match(textOf(second!), /^〔.*〕\n\[m3\] Masou#a2 .*: ↩m1 吃了吗$/);

  const entries = await log.entries(G);
  assert.deepEqual(entries.map((e) => e.lastSeq), [2, 3]);
  assert.equal(await log.tokenCount(G), entries.reduce((s, e) => s + e.tokens, 0));
  await app.stop();
});

test("remembers nicknames so later mentions of the same person are readable", async () => {
  const { app, log, say } = await setup();
  await say("U1", "@U9 你来了", { segments: [{ type: "text", content: "@U9 你来了" }], mentions: [{ userId: "U9", displayName: "U9", isBot: false }] });
  const first = await log.appendPendingBatch(G);
  assert.match(textOf(first!), /: @某人#a2 你来了$/);

  await say("U9", "来了", { sender: "小林" } as Partial<NormalizedMessage>);
  await say("U1", "@U9 欢迎", { segments: [{ type: "text", content: "@U9 欢迎" }], mentions: [{ userId: "U9", displayName: "U9", isBot: false }] });
  const second = await log.appendPendingBatch(G);
  assert.match(textOf(second!), /小林#a2 .*: 来了\n\[m3\] 白川#a1 .*: @小林#a2 欢迎$/);
  await app.stop();
});

test("caps a long backlog and says how much was skipped", async () => {
  const { app, log, say } = await setup(2);
  for (const t of ["一", "二", "三", "四"]) await say("U1", t);
  const entry = await log.appendPendingBatch(G);
  assert.match(textOf(entry!), /〔之前还有 2 条消息没看到〕\n\[m3\].*三\n\[m4\].*四$/);
  await app.stop();
});

test("serializes images identically every time so the prefix stays cacheable", async () => {
  const { app, log, say, mediaDir } = await setup();
  writeFileSync(join(mediaDir, "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await say("U1", "看", { segments: [{ type: "image", url: "u", description: null, isSticker: false, file: "a.png" }] });
  await log.appendPendingBatch(G);
  await log.appendEntry(G, { role: "assistant", content: [], toolCalls: [{ id: "c1", type: "function", function: { name: "say", arguments: "{}" } }] });
  await log.appendEntry(G, { role: "tool", content: [{ type: "text", text: "ok" }], toolCallId: "c1" });

  const entries = await log.entries(G);
  const a = JSON.stringify(await log.toChatMessages(entries));
  const b = JSON.stringify(await log.toChatMessages(entries));
  assert.equal(a, b);
  const messages = await log.toChatMessages(entries);
  assert.deepEqual((messages[0].content as any[]).map((p) => p.type), ["text", "image_url"]);
  assert.match((messages[0].content as any[])[1].image_url.url, /^data:image\/png;base64,/);
  assert.deepEqual(messages.slice(1), [
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "say", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "ok" },
  ]);
  await app.stop();
});

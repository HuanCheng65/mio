import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "koishi";
import sqlite from "@koishijs/plugin-database-sqlite";
import { extendEventTable } from "../src/agent/event-store";
import { extendAliasTable } from "../src/agent/aliases";
import { extendLogTable } from "../src/agent/log-store";
import { extendNoteTable } from "../src/agent/notes";
import { createMemoryQueries } from "../src/console/memory-browser";
import type { GroupRegistry } from "../src/runtime/groups";

const G = "qq:G";

async function setup() {
  const app = new Context();
  app.plugin(sqlite, { path: ":memory:" });
  extendEventTable(app);
  extendAliasTable(app);
  extendLogTable(app);
  extendNoteTable(app);
  await app.start();
  const groups = { list: () => [G, "qq:Quiet"], getMode: (groupId: string) => (groupId === G ? "on" : "record") } as unknown as GroupRegistry;
  const queries = createMemoryQueries(app, groups, { get: async (groupId) => (groupId === G ? "测试群" : undefined) });
  return { app, queries };
}

const note = (about: string, title: string, updatedAt: number, sources: number[] = []) => ({
  groupId: G, kind: "fact" as const, about, title, content: `${title}的内容`, sources, private: false, file: null,
  embedding: [0.1], recallCount: 0, lastRecalledAt: null, createdAt: 1, updatedAt,
});

test("lists groups with note counts and labels who each note is about", async () => {
  const { app, queries } = await setup();
  await app.database.create("mio.alias", { groupId: G, userId: "U1", alias: "a1", name: "白川" });
  await app.database.create("mio.note", note("U1", "白川在考试", 3));
  await app.database.create("mio.note", note("group", "群里的梗", 2));
  await app.database.create("mio.note", note("me", "答应了画图", 1));

  assert.deepEqual(await queries.groups(), [
    { groupId: G, name: "测试群", mode: "on", notes: 3 },
    { groupId: "qq:Quiet", name: null, mode: "record", notes: 0 },
  ]);
  const notes = await queries.notes(G);
  assert.deepEqual(notes.map((n) => [n.title, n.aboutLabel]), [["白川在考试", "白川#a1"], ["群里的梗", "群"], ["答应了画图", "自己"]]);
  assert.equal("embedding" in notes[0], false, "embeddings are not sent to the browser");
  await app.stop();
});

test("shows the original lines a note was written from", async () => {
  const { app, queries } = await setup();
  const msg = (seq: number, sender: string, text: string) => app.database.create("mio.event", {
    groupId: G, seq, kind: "message", platformMessageId: `p${seq}`, userId: "U1", isBot: false, timestamp: seq,
    body: { id: `p${seq}`, sender, senderId: "U1", isBot: false, timestamp: seq, segments: [{ type: "text", content: text }], mentions: [] },
  });
  await msg(4, "白川", "下周考试");
  await msg(5, "白川", "复习不完了");
  await app.database.create("mio.event", { groupId: G, seq: 6, kind: "mute", platformMessageId: "", userId: "", isBot: false, timestamp: 6, body: { muted: true } });

  assert.deepEqual(await queries.sources(G, [6, 4, 99]), [
    { seq: 4, timestamp: 4, sender: "白川", text: "下周考试" },
    { seq: 6, timestamp: 6, sender: "管理", text: "（静音）" },
  ]);
  await app.stop();
});

test("summarises each log segment, newest first, with the sleep handover but not the tail", async () => {
  const { app, queries } = await setup();
  const entry = (segment: number, text: string, tokens: number, createdAt: number) => app.database.create("mio.log_entry", {
    groupId: G, segment, role: "user", content: [{ type: "text", text }], toolCalls: null, toolCallId: null, reasoning: null,
    anthropicContent: null, promptDigest: null, lastSeq: null, tokens, createdAt,
  });
  await entry(1, "〔10-23 周五〕\n[m1] 白川#a1 21:03: 早", 100, 10);
  await entry(1, "[m2] Masou#a2 21:04: 早上好", 50, 11);
  await entry(2, "〔群速写〕\n考试周\n\n〔上一段的交接〕\n白川在复习\n\n〔睡前最后看到的消息〕\n[m2] Masou#a2 21:04: 早上好", 80, 20);

  assert.deepEqual(await queries.segments(G), [
    { segment: 2, startedAt: 20, tokens: 80, summary: "〔群速写〕\n考试周\n\n〔上一段的交接〕\n白川在复习" },
    { segment: 1, startedAt: 10, tokens: 150, summary: null },
  ]);
  await app.stop();
});

import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "koishi";
import sqlite from "@koishijs/plugin-database-sqlite";
import { extendEventTable, EventStore } from "../src/agent/event-store";
import { AliasRegistry, extendAliasTable } from "../src/agent/aliases";
import { extendNoteTable, NoteStore } from "../src/agent/notes";
import { createPersonTool, createRecallTool, createRememberTool, createStickerFinder } from "../src/agent/memory-tools";
import { Recollection } from "../src/agent/recollection";
import type { ToolContext } from "../src/agent/tools";
import type { NormalizedMessage } from "../src/perception/types";

const G = "qq:G";
const ctx: ToolContext = { groupId: G, platform: "qq", shadow: false, allowOutward: true };

/** 确定性的假向量：字符哈希到 64 维再归一化，字面越像相似度越高 */
const fakeEmbedding = {
  async embedBatch(texts: string[]) {
    return texts.map((text) => {
      const v = new Array(64).fill(0);
      for (const ch of text) v[ch.codePointAt(0)! % 64] += 1;
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  },
};

async function setup() {
  const app = new Context();
  app.plugin(sqlite, { path: ":memory:" });
  extendEventTable(app);
  extendAliasTable(app);
  extendNoteTable(app);
  await app.start();
  const events = new EventStore(app);
  const aliases = new AliasRegistry(app);
  const notes = new NoteStore(app, fakeEmbedding as any);
  await aliases.aliasOf(G, "U1", "小林");
  await aliases.aliasOf(G, "U2", "阿九");

  const say = (userId: string, text: string, extra: Partial<NormalizedMessage> = {}, ts = Date.now()) => {
    const id = `p${Math.random()}`;
    const body: NormalizedMessage = { id, sender: userId === "U1" ? "小林" : "阿九", senderId: userId, isBot: false, timestamp: ts, segments: [{ type: "text", content: text }], mentions: [], ...extra };
    return events.append(G, async () => ({ kind: "message", platformMessageId: id, userId, isBot: false, timestamp: ts, body }));
  };
  const deps = { ctx: app, notes, aliases, events };
  return { app, deps, notes, aliases, say, remember: createRememberTool(deps), recall: createRecallTool(deps), person: createPersonTool(deps) };
}

test("remember resolves who it is about, refuses near-duplicates and rewrites on update", async () => {
  const { app, remember, notes, say } = await setup();
  await say("U1", "下周期末考试");

  assert.equal(await remember.run({ kind: "事件", about: "#a1", title: "小林下周期末", content: "小林好像下周要期末考试", sources: "m1" }, ctx), "记下了 #n1");
  const again = await remember.run({ kind: "事件", about: "小林", title: "小林下周期末", content: "小林好像下周要期末考试" }, ctx);
  assert.match(again, /已经有一条很像的：#n1 \[事件·小林#a1\] 小林下周期末/);
  assert.match(again, /update=n1/);

  assert.equal(await remember.run({ kind: "事件", title: "小林考完了", content: "小林上周说要期末，今天说考完了，感觉考得还行", sources: "m3", update: "n1" }, ctx), "改好了 #n1");
  const note = await notes.get(G, 1);
  assert.deepEqual(note!.sources, [1, 3]);
  assert.equal(note!.title, "小林考完了");

  assert.match(await remember.run({ kind: "事件", about: "#a9", title: "x" }, ctx), /不知道 #a9 是谁/);
  await app.stop();
});

test("recall lists titles, then opens one with its source and counts the recall", async () => {
  const { app, remember, recall, notes, say } = await setup();
  await say("U2", "最近心情很差 不想说");
  await remember.run({ kind: "事件", about: "#a2", title: "阿九深夜心情很差", content: "阿九半夜说心情很差，不想说原因", sources: "m1", private: true }, ctx);

  const listed = await recall.run({ query: "阿九 心情" }, ctx);
  assert.match(listed, /^#n1 \[事件·阿九#a2\] 阿九深夜心情很差 \(\d\d-\d\d\)（放心里）$/);

  const opened = await recall.run({ id: "n1" }, ctx);
  assert.match(opened, /阿九半夜说心情很差，不想说原因/);
  assert.match(opened, /对方不提，你就别主动提/);
  assert.match(opened, /出处 \[m1\] 阿九: 最近心情很差 不想说/);
  assert.equal((await notes.get(G, 1))!.recallCount, 1);
  assert.equal(await recall.run({ query: "完全无关的天气预报" }, ctx), "本子里没找到相关的");
  await app.stop();
});

test("person summarizes activity, impressions and notes", async () => {
  const { app, remember, person, say } = await setup();
  await say("U1", "早");
  await say("U1", "我又来了");
  await remember.run({ kind: "印象", about: "#a1", title: "能聊 gal", content: "聊 gal 很对频率，有点话痨" }, ctx);
  await remember.run({ kind: "事实", about: "#a1", title: "小林推过一首歌", content: "小林推过一首洛天依的歌" }, ctx);

  const out = await person.run({ who: "#a1" }, ctx);
  assert.match(out, /^小林#a1：你见过 ta 说了 2 句话/);
  assert.match(out, /印象 #n1：聊 gal 很对频率，有点话痨/);
  assert.match(out, /#n2 \[事实·小林#a1\] 小林推过一首歌/);
  assert.match(await person.run({ who: "群" }, ctx), /不知道 群 是谁/);
  await app.stop();
});

test("stickers are collected from a message's saved image and found by feeling", async () => {
  const { app, deps, remember, say } = await setup();
  await say("U1", "", { segments: [{ type: "image", url: "u", description: null, isSticker: true, file: "cat.gif" }] });
  assert.equal(await remember.run({ kind: "表情包", title: "憋笑 猫", message: "m1" }, ctx), "记下了 #n1");

  const finder = createStickerFinder(app, deps.notes, "/media");
  assert.deepEqual(await finder.find("憋笑的猫"), { path: "/media/cat.gif", description: "憋笑 猫" });
  assert.equal(await finder.find("严肃的会议纪要讨论"), null);
  await app.stop();
});

test("recollection cards people once per segment and surfaces each note once", async () => {
  const { app, remember, aliases, notes, say } = await setup();
  await say("U1", "早", {}, Date.now() - 3 * 86400_000);
  await remember.run({ kind: "事件", about: "#a1", title: "小林期末考试", content: "小林说下周期末考试" }, ctx);
  const recollection = new Recollection(app, notes, aliases, { hintLimit: 3, hintMinScore: 0.5 });

  const batch1 = [await say("U1", "期末考试终于考完了"), await say("U2", "恭喜")];
  const lines1 = await recollection.annotate(G, batch1);
  assert.deepEqual(lines1, [
    "〔小林#a1：记过 1 件事 · 上次说话 3 天前〕",
    "〔第一次见到 阿九#a2 说话〕",
    `〔你隐约记得〕「小林期末考试」(${lines1[2].match(/\((\d\d-\d\d)\)/)![1]})`,
  ]);

  const lines2 = await recollection.annotate(G, [await say("U1", "期末考试考得还行")]);
  assert.deepEqual(lines2, [], "already carded and already surfaced in this segment");

  recollection.resetSegment(G);
  const lines3 = await recollection.annotate(G, [await say("U1", "期末考试的成绩出了")]);
  assert.equal(lines3.length, 2, "a new segment cards and surfaces again");
  await app.stop();
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "koishi";
import sqlite from "@koishijs/plugin-database-sqlite";
import { extendEventTable, EventStore } from "../src/agent/event-store";
import { AliasRegistry, extendAliasTable } from "../src/agent/aliases";
import { Outbox } from "../src/agent/outbox";
import { createReactTool, createSayTool, createStickerTool } from "../src/agent/outward-tools";
import { ToolRegistry, type ToolContext } from "../src/agent/tools";
import type { NormalizedMessage } from "../src/perception/types";

const G = "qq:G";
const qq: ToolContext = { groupId: G, platform: "qq", shadow: false, allowOutward: true };
const instant = { minDelay: 0, maxDelay: 0, typingSpeed: 0 };

function fakeSession(platform = "qq", timestamp = Date.now()) {
  const sent: string[] = [];
  const likes: [string, string][] = [];
  const session = {
    platform,
    messageId: "trigger",
    timestamp,
    bot: { internal: { async setMsgEmojiLike(id: string, emoji: string) { likes.push([id, emoji]); } } },
    async send(content: unknown) {
      sent.push(String(content));
      return [`out${sent.length}`];
    },
  };
  return { session: session as any, sent, likes };
}

async function setup(limits = { minIntervalMs: 0, maxPerHour: 40, maxConsecutive: 6 }) {
  const app = new Context();
  app.plugin(sqlite, { path: ":memory:" });
  extendEventTable(app);
  extendAliasTable(app);
  await app.start();
  const events = new EventStore(app);
  const aliases = new AliasRegistry(app);
  const outbox = new Outbox(limits);
  await aliases.aliasOf(G, "OPENID_A", "小林");
  const msg: NormalizedMessage = { id: "plat-1", sender: "小林", senderId: "OPENID_A", isBot: false, timestamp: Date.now(), segments: [], mentions: [] };
  await events.append(G, async () => ({ kind: "message", platformMessageId: "plat-1", userId: "OPENID_A", isBot: false, timestamp: msg.timestamp, body: msg }));
  const deps = { events, aliases, outbox, delivery: instant };
  return { app, outbox, deps, say: createSayTool(deps) };
}

test("say escapes text, turns aliases into real mentions and quotes by message id", async () => {
  const { app, outbox, say } = await setup();
  const { session, sent } = fakeSession();
  outbox.noteUserMessage(G, session);

  assert.equal(await say.run({ text: "@#a1 <3 & @小林#a1 好", reply_to: "m1" }, qq), "发出去了");
  assert.deepEqual(sent, ['<quote id="plat-1"/><at id="OPENID_A"/> &lt;3 &amp; <at id="OPENID_A"/> 好']);
  assert.equal(outbox.isOwnMessage(G, "out1"), true);
  await app.stop();
});

test("say refuses unknown aliases and message ids without sending", async () => {
  const { app, outbox, say } = await setup();
  const { session, sent } = fakeSession();
  outbox.noteUserMessage(G, session);

  assert.match(await say.run({ text: "@#a9 你好" }, qq), /不认识 #a9.*没发/);
  assert.match(await say.run({ text: "嗯", reply_to: "m99" }, qq), /找不到 m99.*没发/);
  assert.match(await say.run({ text: "嗯", reply_to: "昨天那条" }, qq), /m12 这样/);
  assert.deepEqual(sent, []);
  await app.stop();
});

test("shadow mode counts toward the guardrails but sends nothing", async () => {
  const { app, outbox, say } = await setup({ minIntervalMs: 0, maxPerHour: 40, maxConsecutive: 2 });
  const { session, sent } = fakeSession();
  outbox.noteUserMessage(G, session);
  const shadow = { ...qq, shadow: true };

  assert.match(await say.run({ text: "一" }, shadow), /影子模式/);
  assert.match(await say.run({ text: "二" }, shadow), /影子模式/);
  assert.match(await say.run({ text: "三" }, shadow), /连着说了 2 条没人接/);
  assert.deepEqual(sent, []);

  outbox.noteUserMessage(G, session);
  assert.match(await say.run({ text: "四" }, shadow), /影子模式/, "someone speaking resets the streak");
  await app.stop();
});

test("guardrails report interval and hourly limits", () => {
  const outbox = new Outbox({ minIntervalMs: 5000, maxPerHour: 2, maxConsecutive: 99 });
  const t = 1_000_000;
  outbox.recordSent(G, [], t);
  assert.match(outbox.blocker(G, t + 1000)!, /4 秒内先别发/);
  outbox.recordSent(G, [], t + 6000);
  assert.match(outbox.blocker(G, t + 20000)!, /这一小时已经说了 2 条/);
  assert.equal(outbox.blocker(G, t + 3600_000 + 7000), null, "old sends fall out of the hour");
});

test("say will not fall back to an active message once the passive window is gone", async () => {
  const { app, outbox, say } = await setup();
  const { session, sent } = fakeSession("qq", Date.now() - 10 * 60_000);
  outbox.noteUserMessage(G, session);

  assert.match(await say.run({ text: "还在吗" }, qq), /没发出去：.*超出被动回复窗口/);
  assert.deepEqual(sent, []);
  await app.stop();
});

test("react is offered only on OneBot and validates the emoji", async () => {
  const { app, outbox, deps } = await setup();
  const react = createReactTool(deps);
  const registry = new ToolRegistry([react, createSayTool(deps)], () => {});
  assert.deepEqual(registry.definitions("qq").map((d) => d.function.name), ["say"]);
  assert.deepEqual(registry.definitions("onebot").map((d) => d.function.name), ["react", "say"]);

  const { session, likes } = fakeSession("onebot");
  outbox.noteUserMessage(G, session);
  const onebot = { ...qq, platform: "onebot" };
  assert.match(await react.run({ message: "m1", emoji: "不存在的表情" }, onebot), /不能用/);
  assert.equal(await react.run({ message: "m1", emoji: "赞" }, onebot), "给 m1 点了赞");
  assert.equal(likes.length, 1);
  assert.equal(likes[0][0], "plat-1");
  await app.stop();
});

test("sticker sends the found image and says so when nothing fits", async () => {
  const { app, outbox, deps } = await setup();
  const dir = mkdtempSync(join(tmpdir(), "mio-sticker-"));
  writeFileSync(join(dir, "cat.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const sticker = createStickerTool({
    ...deps,
    stickers: { async find(feeling) { return feeling.includes("猫") ? { path: join(dir, "cat.png"), description: "憋笑的猫" } : null; } },
  });
  const { session, sent } = fakeSession();
  outbox.noteUserMessage(G, session);

  assert.match(await sticker.run({ feeling: "震惊" }, qq), /没找到/);
  assert.equal(await sticker.run({ feeling: "憋笑 猫" }, qq), "发了：憋笑的猫");
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^<img src="data:image\/png;base64,/);
  await app.stop();
});

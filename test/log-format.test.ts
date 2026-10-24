import test from "node:test";
import assert from "node:assert/strict";
import { renderBatch, type BatchContext } from "../src/agent/log-format";
import type { MioEventRow } from "../src/agent/event-store";
import type { NormalizedMessage } from "../src/perception/types";

// 2026-10-23 21:03 (Friday) in the local timezone
const T = new Date(2026, 9, 23, 21, 3).getTime();

function message(seq: number, msg: Partial<NormalizedMessage>): MioEventRow {
  const body: NormalizedMessage = {
    id: `p${seq}`,
    sender: "白川",
    senderId: "U1",
    isBot: false,
    timestamp: T,
    segments: [],
    mentions: [],
    ...msg,
  };
  return { id: seq, groupId: "qq:G", seq, kind: "message", platformMessageId: body.id, userId: body.senderId, isBot: body.isBot, timestamp: body.timestamp, body };
}

const ctx = (extra: Partial<BatchContext> = {}): BatchContext => ({
  aliases: new Map([["U1", "a1"], ["U2", "a2"]]),
  names: new Map(),
  seqByMessageId: new Map([["p5", 5]]),
  botName: "澪",
  ...extra,
});

test("renders a dated batch with stable ids, roles and aliases", () => {
  const parts = renderBatch([
    message(7, { senderRole: "管理员", segments: [{ type: "text", content: "下周终于考完了" }] }),
    message(8, { sender: "Masou", senderId: "U2", segments: [{ type: "face", faceId: 1, name: "撇嘴" }] }),
  ], ctx());

  assert.deepEqual(parts, [{
    type: "text",
    text: "〔10-23 周五〕\n[m7] 【管理员】白川#a1 21:03: 下周终于考完了\n[m8] Masou#a2 21:03: [表情:撇嘴]",
  }]);
});

test("points replies and recalls at earlier [mN] ids when known", () => {
  const recall: MioEventRow = { id: 9, groupId: "qq:G", seq: 9, kind: "recall", platformMessageId: "p5", userId: "U2", isBot: false, timestamp: T, body: { recalledMessageId: "p5", recalledBy: "Masou" } };
  const parts = renderBatch([
    message(7, { replyTo: { messageId: "p5", sender: "Masou", preview: "早" }, segments: [{ type: "text", content: "早啊" }] }),
    message(8, { replyTo: { messageId: "gone", sender: "Masou", preview: "很久以前" }, segments: [{ type: "text", content: "嗯" }] }),
    recall,
  ], ctx());

  const text = (parts[0] as { text: string }).text;
  assert.match(text, /\[m7\] 白川#a1 21:03: ↩m5 早啊/);
  assert.match(text, /\[m8\] 白川#a1 21:03: ↩Masou「很久以前」 嗯/);
  assert.match(text, /〔Masou 撤回了 m5〕/);
});

test("marks QQ quotes of the bot's own messages and quotes that could not be matched", () => {
  const parts = renderBatch([
    message(7, { replyTo: { messageId: "sent1", sender: "澪", preview: "尾巴在下一张", refIdx: "R1", fromBot: true }, segments: [{ type: "text", content: "你能看到吗" }] }),
    message(8, { replyTo: { messageId: "", sender: "某人", preview: "打个招呼", refIdx: "R2" }, segments: [{ type: "text", content: "好" }] }),
  ], ctx());

  const text = (parts[0] as { text: string }).text;
  assert.match(text, /\[m7\] 白川#a1 21:03: ↩澪（你）「尾巴在下一张」 你能看到吗/);
  assert.match(text, /\[m8\] 白川#a1 21:03: ↩一条没对上的消息「打个招呼」 好/);
});

test("tags mentions with aliases and leaves the bot mention alone", () => {
  const parts = renderBatch([message(7, {
    segments: [{ type: "text", content: "@Masou @澪 来看" }],
    mentions: [{ userId: "U2", displayName: "Masou", isBot: false }, { userId: "BOT", displayName: "澪", isBot: true }],
  })], ctx());
  assert.match((parts[0] as { text: string }).text, /: @Masou#a2 @澪 来看$/);
});

test("names mentioned users who only appear as a platform id", () => {
  const unknown = renderBatch([message(7, {
    segments: [{ type: "text", content: " @U2 还真是" }],
    mentions: [{ userId: "U2", displayName: "U2", isBot: false }],
  })], ctx());
  assert.match((unknown[0] as { text: string }).text, /21:03: @某人#a2 还真是$/);

  const known = renderBatch([message(7, {
    segments: [{ type: "text", content: "@U2 还真是" }],
    mentions: [{ userId: "U2", displayName: "U2", isBot: false }],
  })], ctx({ names: new Map([["U2", "Masou"]]) }));
  assert.match((known[0] as { text: string }).text, /21:03: @Masou#a2 还真是$/);
});

test("places each saved image right after its message, labelled with the sender", () => {
  const parts = renderBatch([
    message(7, { segments: [
      { type: "text", content: "看" },
      { type: "image", url: "u1", description: null, isSticker: false, file: "a.png" },
      { type: "image", url: "u2", description: null, isSticker: false },
    ] }),
    message(8, { sender: "Masou", senderId: "U2", segments: [{ type: "image", url: "u3", description: null, isSticker: true, file: "s.gif" }] }),
    message(9, { segments: [{ type: "text", content: "笑死" }] }),
  ], ctx({ annotations: ["〔旁注〕"] }));

  assert.deepEqual(parts, [
    { type: "text", text: "〔10-23 周五〕\n[m7] 白川#a1 21:03: 看[图1][图2：没能保存]\n[m7 白川#a1 发的图1]" },
    { type: "image", file: "a.png" },
    { type: "text", text: "[m8] Masou#a2 21:03: [表情包]\n[m8 Masou#a2 发的表情包]" },
    { type: "image", file: "s.gif" },
    { type: "text", text: "[m9] 白川#a1 21:03: 笑死\n〔旁注〕" },
  ]);
});

test("notes skipped backlog and marks the bot's own messages", () => {
  const parts = renderBatch([message(7, { isBot: true, senderId: "BOT", segments: [{ type: "text", content: "在" }] })], ctx({ skipped: 120 }));
  assert.equal((parts[0] as { text: string }).text, "〔10-23 周五〕\n〔之前还有 120 条消息没看到〕\n[m7] 澪（你） 21:03: 在");
});

test("refuses to render a sender without an alias", () => {
  assert.throws(() => renderBatch([message(7, { senderId: "U9" })], ctx()), /no alias for sender U9/);
});

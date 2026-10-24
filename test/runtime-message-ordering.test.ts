import test from "node:test";
import assert from "node:assert/strict";
import { ContextRenderer } from "../src/perception/renderer";
import type { NormalizedMessage } from "../src/perception/types";

function createMessage(input: Partial<NormalizedMessage> & { id: string; sender: string; senderId: string }): NormalizedMessage {
  return {
    id: input.id,
    sender: input.sender,
    senderId: input.senderId,
    isBot: input.isBot ?? false,
    timestamp: input.timestamp ?? Date.now(),
    segments: input.segments ?? [{ type: "text", content: input.rawContent ?? "msg" }],
    mentions: input.mentions ?? [],
    rawContent: input.rawContent,
    replyTo: input.replyTo,
    senderRole: input.senderRole,
    senderTitle: input.senderTitle,
    reactions: input.reactions,
    recalled: input.recalled,
    recalledAt: input.recalledAt,
    isSystemEvent: input.isSystemEvent,
  };
}

test("renderer separates new messages with a divider and exposes new portion", () => {
  const renderer = new ContextRenderer();
  const messages: NormalizedMessage[] = [
    createMessage({
      id: "u1",
      sender: "Alice",
      senderId: "10001",
      timestamp: 1000,
      rawContent: "older user message",
      segments: [{ type: "text", content: "older user message" }],
    }),
    createMessage({
      id: "b1",
      sender: "Mio",
      senderId: "bot",
      isBot: true,
      timestamp: 2000,
      rawContent: "newer bot message",
      segments: [{ type: "text", content: "newer bot message" }],
    }),
  ];

  const { text, newMessagesText, msgMap } = renderer.render(messages, new Set(["b1"]));

  const idxOld = text.indexOf("older user message");
  const idxDivider = text.indexOf("以下是你刚划到的新消息");
  const idxNew = text.indexOf("newer bot message");
  assert.ok(idxOld >= 0 && idxDivider > idxOld && idxNew > idxDivider);
  assert.match(newMessagesText, /\[m2\] .*newer bot message/);
  assert.doesNotMatch(newMessagesText, /older user message/);
  assert.equal(msgMap.get("m1")?.id, "u1");
  assert.equal(msgMap.get("m2")?.id, "b1");
});

test("renderer can omit selected messages from history rendering", () => {
  const renderer = new ContextRenderer();
  const messages: NormalizedMessage[] = [
    createMessage({
      id: "old",
      sender: "Alice",
      senderId: "10001",
      timestamp: 1000,
      rawContent: "older user message",
      segments: [{ type: "text", content: "older user message" }],
    }),
    createMessage({
      id: "new",
      sender: "Bob",
      senderId: "10002",
      timestamp: 2000,
      rawContent: "new message body",
      segments: [{ type: "text", content: "new message body" }],
    }),
  ];

  const { text } = renderer.render(messages, new Set(), new Set(["new"]));

  assert.match(text, /older user message/);
  assert.doesNotMatch(text, /new message body/);
});

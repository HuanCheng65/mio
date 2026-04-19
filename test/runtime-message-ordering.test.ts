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

test("renderer keeps chronological order and marks new messages inline", () => {
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

  const { text } = renderer.render(messages, new Set(["u1"]));

  const idxUser = text.indexOf("older user message");
  const idxBot = text.indexOf("newer bot message");
  assert.notEqual(idxUser, -1);
  assert.notEqual(idxBot, -1);
  assert.ok(idxUser < idxBot, "older user message should appear before newer bot message");
  assert.match(text, /\[新消息\].*older user message/);
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

import test from "node:test";
import assert from "node:assert/strict";
import { humanizedSend } from "../src/delivery/humanize";
import { passiveReplyBlocker, recordPassiveReply } from "../src/platform/qq";

test("passiveReplyBlocker stops before QQ's 5-minute window and 5-reply limit", () => {
  const fresh = { platform: "qq", messageId: "m", timestamp: Date.now() } as any;
  assert.equal(passiveReplyBlocker(fresh), null);
  for (let i = 0; i < 5; i++) recordPassiveReply(fresh);
  assert.match(passiveReplyBlocker(fresh)!, /5 次被动回复/);

  const stale = { platform: "qq", messageId: "m", timestamp: Date.now() - 4.6 * 60_000 } as any;
  assert.match(passiveReplyBlocker(stale)!, /超出被动回复窗口/);

  const onebot = { platform: "onebot", messageId: "m", timestamp: 0 } as any;
  assert.equal(passiveReplyBlocker(onebot), null);
});

test("humanizedSend stops instead of sending once the passive reply window is gone", async () => {
  const sent: string[] = [];
  const session = {
    platform: "qq",
    messageId: "m",
    timestamp: Date.now() - 10 * 60_000,
    async send(part: string) {
      sent.push(part);
    },
  } as any;

  const result = await humanizedSend(session, "你好", { minDelay: 0, maxDelay: 0, typingSpeed: 0 });
  assert.deepEqual(sent, []);
  assert.deepEqual(result.sentParts, []);
  assert.match(result.blocked!, /超出被动回复窗口/);
});

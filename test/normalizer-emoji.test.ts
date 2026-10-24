import test from "node:test";
import assert from "node:assert/strict";
import { h, type Session } from "koishi";
import { MessageNormalizer } from "../src/perception/normalizer";

const session = (elements: h[]) => ({
  platform: "qq",
  selfId: "BOT",
  userId: "U1",
  guildId: "G",
  messageId: "m1",
  timestamp: 0,
  elements,
  event: { member: { nick: "小林", roles: [] } },
}) as unknown as Session;

test("names official QQ emoji elements instead of reporting them as unknown", async () => {
  const normalizer = new MessageNormalizer(null, "澪");
  const msg = await normalizer.normalize(session([
    h("emoji", { id: "1", name: "/流泪" }),
    h("emoji", { name: "" }),
  ]), true);
  assert.deepEqual(msg.segments, [
    { type: "face", faceId: 1, name: "/流泪" },
    { type: "face", faceId: 0, name: "表情" },
  ]);
});

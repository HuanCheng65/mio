import test from "node:test";
import assert from "node:assert/strict";
import { parseGroupId, toGroupId } from "../src/runtime/groups";

test("group ids round-trip platform and channel id", () => {
  const groupId = toGroupId("qq", "2860C352DF05A086C87D7CFD6FA5012E");
  assert.equal(groupId, "qq:2860C352DF05A086C87D7CFD6FA5012E");
  assert.deepEqual(parseGroupId(groupId), { platform: "qq", channelId: "2860C352DF05A086C87D7CFD6FA5012E" });
  assert.throws(() => parseGroupId("123456"), /invalid mio groupId/);
});

import test from "node:test";
import assert from "node:assert/strict";
import type { Context } from "koishi";
import { GroupRegistry, parseGroupId, toGroupId } from "../src/runtime/groups";

test("group ids round-trip platform and channel id", () => {
  const groupId = toGroupId("qq", "2860C352DF05A086C87D7CFD6FA5012E");
  assert.equal(groupId, "qq:2860C352DF05A086C87D7CFD6FA5012E");
  assert.deepEqual(parseGroupId(groupId), { platform: "qq", channelId: "2860C352DF05A086C87D7CFD6FA5012E" });
  assert.throws(() => parseGroupId("123456"), /invalid mio groupId/);
});

function registryWith(rows: { platform: string; id: string; mioMode: string }[]) {
  let ready!: () => Promise<void>;
  const ctx = {
    on: (_event: string, listener: () => Promise<void>) => { ready = listener; },
    database: { get: async () => rows },
  } as unknown as Context;
  return { registry: new GroupRegistry(ctx), ready: () => ready() };
}

test("loads modes and tells which groups Mio wakes in", async () => {
  const { registry, ready } = registryWith([
    { platform: "qq", id: "A", mioMode: "on" },
    { platform: "qq", id: "B", mioMode: "shadow" },
    { platform: "qq", id: "C", mioMode: "muted" },
  ]);
  await ready();
  assert.equal(registry.runsAgent("qq:A"), true);
  assert.equal(registry.isShadow("qq:B"), true);
  assert.equal(registry.runsAgent("qq:C"), false);
  assert.equal(registry.isRecorded("qq:C"), true);
  assert.equal(registry.getMode("qq:D"), "off");
});

test("refuses to load a mode left over from a rename", async () => {
  const { ready } = registryWith([{ platform: "qq", id: "A", mioMode: "agent" }]);
  await assert.rejects(ready(), /qq:A 的 mioMode 是未知的 "agent"/);
});

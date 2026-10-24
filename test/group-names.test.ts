import test from "node:test";
import assert from "node:assert/strict";
import { GroupNames } from "../src/agent/group-names";
import { renderBatch } from "../src/agent/log-format";

const quiet = { warn() {} } as any;

function qqBot(reply: () => unknown) {
  const calls: string[] = [];
  const bot = {
    platform: "qq",
    internal: { http: () => async (url: string) => { calls.push(url); return { data: reply() }; } },
  };
  return { bot, calls };
}

test("asks official QQ for the group name and keeps it for a while", async () => {
  const { bot, calls } = qqBot(() => ({ group_openid: "G1", group_name: "临界美少女游戏鉴赏协会" }));
  const names = new GroupNames({ bots: [bot] } as any, quiet);

  assert.equal(await names.get("qq:G1", 0), "临界美少女游戏鉴赏协会");
  assert.equal(await names.get("qq:G1", 60_000), "临界美少女游戏鉴赏协会");
  assert.deepEqual(calls, ["/v2/groups/G1/info"]);
  await names.get("qq:G1", 7 * 3600_000);
  assert.equal(calls.length, 2, "refreshed after six hours");
});

test("a failed lookup is reported, leaves the name out, and is retried later", async () => {
  let fail = true;
  const { bot, calls } = qqBot(() => {
    if (fail) throw new Error("11253 应用无接口访问权限");
    return { group_name: "机器人测试" };
  });
  const warned: unknown[] = [];
  const names = new GroupNames({ bots: [bot] } as any, { warn: (...args: unknown[]) => warned.push(args) } as any);

  assert.equal(await names.get("qq:G2", 0), undefined);
  assert.equal(warned.length, 1);
  assert.equal(await names.get("qq:G2", 60_000), undefined, "not retried right away");
  fail = false;
  assert.equal(await names.get("qq:G2", 11 * 60_000), "机器人测试");
  assert.equal(calls.length, 2);
});

test("uses getGuild on other platforms", async () => {
  const bot = { platform: "onebot", getGuild: async (id: string) => ({ id, name: `群${id}` }) };
  assert.equal(await new GroupNames({ bots: [bot] } as any, quiet).get("onebot:123"), "群123");
});

test("puts the group name next to the date", () => {
  const T = new Date(2026, 9, 23, 21, 3).getTime();
  const parts = renderBatch([{ id: 1, groupId: "qq:G", seq: 1, kind: "recall", platformMessageId: "x", userId: "U", isBot: false, timestamp: T, body: { recalledMessageId: "x", recalledBy: "小林" } }],
    { aliases: new Map(), names: new Map(), seqByMessageId: new Map(), botName: "澪", groupName: "机器人测试" });
  assert.equal((parts[0] as { text: string }).text, "〔10-23 周五 · 机器人测试〕\n〔小林 撤回了一条消息〕");
});

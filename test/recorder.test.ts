import test from "node:test";
import assert from "node:assert/strict";
import type { Context, Session } from "koishi";
import { registerRecorder, type RecordListener } from "../src/agent/recorder";
import type { EventStore, MioEventRow, NewEvent } from "../src/agent/event-store";
import type { GroupRegistry } from "../src/runtime/groups";

/** 只捕获录制器注册的处理函数；事件写进数组 */
function setup(recorded: (groupId: string) => boolean = () => true) {
  const handlers = new Map<string, (session: Session) => void>();
  const ctx = {
    middleware: () => {},
    on: (event: string, handler: (session: Session) => void) => handlers.set(event, handler),
  } as unknown as Context;
  const rows: MioEventRow[] = [];
  const events = {
    async append(groupId: string, prepare: () => Promise<NewEvent>) {
      const row = { id: rows.length + 1, groupId, seq: rows.length + 1, ...(await prepare()) };
      rows.push(row);
      return row;
    },
  } as unknown as EventStore;
  const heard: string[] = [];
  const listener: RecordListener = (_groupId, _session, event) => heard.push(event.kind);
  const errors: unknown[] = [];
  registerRecorder(ctx, {
    groups: { isRecorded: recorded } as unknown as GroupRegistry,
    normalizer: null as never,
    events,
    media: null as never,
    logger: { error: (...args: unknown[]) => errors.push(args), warn: () => {} } as never,
    botName: "澪",
    listeners: [listener],
  });
  // 和 OneBot 适配器一样：原始事件挂在 session.onebot 上
  const notice = async (data: Record<string, unknown>, platform = "onebot") => {
    handlers.get("internal/session")!({ platform, selfId: "BOT", onebot: { post_type: "notice", ...data } } as unknown as Session);
    await new Promise((r) => setImmediate(r));
  };
  return { rows, heard, errors, notice };
}

test("records OneBot bans, including Mio's own and whole-group ones", async () => {
  const { rows, heard, errors, notice } = setup();
  await notice({ notice_type: "group_ban", sub_type: "ban", group_id: 42, user_id: 1001, operator_id: 9, duration: 600 });
  await notice({ notice_type: "group_ban", sub_type: "ban", group_id: 42, user_id: "BOT", operator_id: 9, duration: 60 });
  await notice({ notice_type: "group_ban", sub_type: "ban", group_id: 42, user_id: 0, operator_id: 9, duration: 0 });
  await notice({ notice_type: "group_ban", sub_type: "lift_ban", group_id: 42, user_id: 0, operator_id: 9, duration: 0 });

  assert.deepEqual(errors, []);
  assert.deepEqual(rows.map((r) => [r.groupId, r.kind, r.body]), [
    ["onebot:42", "ban", { operatorId: "9", targetId: "1001", targetIsSelf: false, lift: false, durationSec: 600 }],
    ["onebot:42", "ban", { operatorId: "9", targetId: "BOT", targetIsSelf: true, lift: false, durationSec: 60 }],
    ["onebot:42", "ban", { operatorId: "9", targetId: null, targetIsSelf: true, lift: false, durationSec: 0 }],
    ["onebot:42", "ban", { operatorId: "9", targetId: null, targetIsSelf: true, lift: true, durationSec: 0 }],
  ]);
  assert.deepEqual(heard, ["ban", "ban", "ban", "ban"], "the agent hears bans so it can block sending");
});

test("records reactions from others, one event per emoji, but not Mio's own", async () => {
  const { rows, notice } = setup();
  await notice({ notice_type: "group_msg_emoji_like", group_id: 42, user_id: 1001, message_id: 555, likes: [{ emoji_id: "76", count: 1 }, { emoji_id: "999999", count: 0 }] });
  await notice({ notice_type: "group_msg_emoji_like", group_id: 42, user_id: "BOT", message_id: 555, likes: [{ emoji_id: "76", count: 1 }] });

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.body), [
    { messageId: "555", userId: "1001", emoji: "赞", add: true },
    { messageId: "555", userId: "1001", emoji: "表情999999", add: false },
  ]);
});

test("ignores notices from other platforms and from groups that are not recorded", async () => {
  const off = setup(() => false);
  await off.notice({ notice_type: "group_ban", sub_type: "ban", group_id: 42, user_id: 1, operator_id: 9, duration: 60 });
  assert.equal(off.rows.length, 0);

  const qq = setup();
  await qq.notice({ notice_type: "group_ban", sub_type: "ban", group_id: 42, user_id: 1, operator_id: 9, duration: 60 }, "qq");
  assert.equal(qq.rows.length, 0);
});

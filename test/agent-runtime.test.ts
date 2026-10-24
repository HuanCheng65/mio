import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "koishi";
import sqlite from "@koishijs/plugin-database-sqlite";
import { extendEventTable, EventStore } from "../src/agent/event-store";
import { AliasRegistry, extendAliasTable } from "../src/agent/aliases";
import { AgentLog, extendLogTable, type ToolCall } from "../src/agent/log-store";
import { AgentRuntime, type SleepOptions } from "../src/agent/runtime";
import { ToolRegistry, type AgentTool } from "../src/agent/tools";
import type { AgentStep } from "../src/agent/llm";
import type { NormalizedMessage } from "../src/perception/types";

const G = "qq:G";
const quiet = { info() {}, debug() {}, warn() {}, error() {} } as any;

const call = (id: string, name: string, args: unknown): ToolCall => ({
  id,
  type: "function",
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
});
const reply = (toolCalls: ToolCall[] = [], extra: Partial<AgentStep> = {}): AgentStep => ({
  content: "",
  reasoning: null,
  toolCalls,
  usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
  ...extra,
});

async function setup(
  script: AgentStep[],
  options: { maxSteps?: number; tools?: AgentTool[]; onStep?: (n: number) => Promise<void>; sleep?: Partial<SleepOptions> } = {},
) {
  const app = new Context();
  app.plugin(sqlite, { path: ":memory:" });
  extendEventTable(app);
  extendAliasTable(app);
  extendLogTable(app);
  await app.start();
  const events = new EventStore(app);
  const log = new AgentLog(app, new AliasRegistry(app), { botName: "澪", mediaDir: mkdtempSync(join(tmpdir(), "mio-")), maxBatchEvents: 80 });

  const requests: unknown[][] = [];
  const llm = {
    async step(messages: unknown[]) {
      requests.push(JSON.parse(JSON.stringify(messages)));
      await options.onStep?.(requests.length);
      const next = script.shift();
      if (!next) throw new Error("script exhausted");
      return next;
    },
  };

  const ran: string[] = [];
  const errors: string[] = [];
  const echo: AgentTool = {
    name: "note",
    description: "test",
    parameters: { type: "object" },
    async run(args) {
      ran.push(String(args.text));
      return `记下了：${args.text}`;
    },
  };
  const tools = new ToolRegistry(options.tools ?? [echo], (c, e) => errors.push(`${c.function.name}: ${e}`));
  const segmentStarts: string[] = [];
  const runtime = new AgentRuntime(log, llm as any, tools, {
    model: { providerId: "p", modelName: "m", maxTokens: 100 },
    maxSteps: options.maxSteps ?? 6,
    systemPrompt: "SYSTEM",
    isShadow: () => false,
    sleep: { prompt: "〔{time} 睡前整理〕", maxSteps: 6, compactTokens: 1_000_000, idleMs: 3600_000, minTokens: 0, tailEvents: 30, ...options.sleep },
    onSegmentStart: (g) => segmentStarts.push(g),
  }, quiet);

  let n = 0;
  const say = (text: string) => {
    const id = `p${++n}`;
    const msg: NormalizedMessage = { id, sender: "小林", senderId: "U1", isBot: false, timestamp: Date.now(), segments: [{ type: "text", content: text }], mentions: [] };
    return events.append(G, async () => ({ kind: "message", platformMessageId: id, userId: "U1", isBot: false, timestamp: msg.timestamp, body: msg }));
  };
  return { app, log, runtime, requests, ran, errors, say, segmentStarts };
}

test("a wake with no tool calls ends after one step and keeps the reasoning", async () => {
  const { app, log, runtime, requests, say } = await setup([reply([], { reasoning: "没什么要说的" })]);
  await say("早");
  await runtime.wake(G);

  assert.equal(requests.length, 1);
  assert.deepEqual((requests[0][0] as any), { role: "system", content: "SYSTEM" });
  const entries = await log.entries(G);
  assert.deepEqual(entries.map((e) => e.role), ["user", "assistant"]);
  assert.equal(entries[1].reasoning, "没什么要说的");
  await app.stop();
});

test("tool results are appended and each request extends the previous one", async () => {
  const { app, runtime, requests, ran, say } = await setup([
    reply([call("c1", "note", { text: "a" }), call("c2", "note", { text: "b" })], { reasoning: "记两笔" }),
    reply(),
  ]);
  await say("早");
  await runtime.wake(G);

  assert.deepEqual(ran, ["a", "b"]);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].slice(0, requests[0].length), requests[0], "the previous request must be an exact prefix");
  assert.deepEqual(requests[1].slice(requests[0].length).map((m: any) => [m.role, m.tool_call_id ?? null, m.reasoning_content ?? null]), [
    ["assistant", null, "记两笔"],
    ["tool", "c1", null],
    ["tool", "c2", null],
  ]);
  await app.stop();
});

test("stops at the step limit", async () => {
  const loop = () => reply([call(`c${Math.random()}`, "note", { text: "x" })]);
  const { app, runtime, requests, say } = await setup([loop(), loop(), loop(), loop()], { maxSteps: 2 });
  await say("早");
  await runtime.wake(G);
  assert.equal(requests.length, 2);
  await app.stop();
});

test("messages that arrive during a wake are added before the next step", async () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  ctx = await setup([reply([call("c1", "note", { text: "a" })]), reply()], {
    onStep: async (n) => {
      if (n === 1) await ctx.say("@澪 在吗");
    },
  });
  await ctx.say("早");
  await ctx.runtime.wake(G);

  const last = ctx.requests[1].at(-1) as any;
  assert.equal(last.role, "user");
  assert.match(last.content, /\[m2\] 小林#a1 .*: @澪 在吗/);
  await ctx.app.stop();
});

test("a wake requested while running becomes exactly one more run", async () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let wakes: Promise<void>[] = [];
  ctx = await setup([reply(), reply()], {
    onStep: async (n) => {
      if (n === 1) {
        await ctx.say("又来了");
        wakes = [ctx.runtime.wake(G), ctx.runtime.wake(G)];
      }
    },
  });
  await ctx.say("早");
  await ctx.runtime.wake(G);
  await Promise.all(wakes);

  assert.equal(ctx.requests.length, 2);
  const entries = await ctx.log.entries(G);
  assert.deepEqual(entries.map((e) => e.role), ["user", "assistant", "user", "assistant"]);
  await ctx.app.stop();
});

test("bad tool calls come back as results the model can act on", async () => {
  const boom: AgentTool = { name: "boom", description: "", parameters: {}, async run() { throw new Error("kaput"); } };
  const { app, log, runtime, errors, say } = await setup([
    reply([call("c1", "missing", {}), call("c2", "boom", "{not json"), call("c3", "boom", {})]),
    reply(),
  ], { tools: [boom] });
  await say("早");
  await runtime.wake(G);

  const results = (await log.entries(G)).filter((e) => e.role === "tool").map((e) => (e.content[0] as any).text);
  assert.deepEqual(results, ["没有叫 missing 的工具。可用的有：boom", "参数不是合法的 JSON：{not json", "boom 出错了，这次没有完成。"]);
  assert.deepEqual(errors, ["boom: Error: kaput"]);
  await app.stop();
});

const loud: AgentTool = { name: "say", description: "", parameters: {}, outward: true, async run() { return "发出去了"; } };
const finish = (sketch = "群里很安静", handoff = "小林说要去考试") => reply([], { content: `【群速写】\n${sketch}\n【交接】\n${handoff}` });

test("sleep consolidates without speaking and opens a new segment", async () => {
  const note: AgentTool = { name: "note", description: "", parameters: {}, async run() { return "记下了"; } };
  const { app, log, runtime, say, segmentStarts } = await setup(
    [reply([call("c1", "say", { text: "晚安" }), call("c2", "note", {})]), finish(), reply()],
    { tools: [loud, note] },
  );
  await say("早");
  await runtime.requestSleep(G);

  const old = await log.entries(G);
  assert.equal(old.length, 1, "only the new segment is visible");
  const opening = (old[0].content[0] as any).text as string;
  assert.match(opening, /^〔群速写〕\n群里很安静\n\n〔上一段的交接〕\n小林说要去考试\n\n〔睡前最后看到的消息〕\n〔.*〕\n\[m1\] 小林#a1 .*: 早$/);
  assert.deepEqual(segmentStarts, [G]);

  const all = await app.database.get("mio.log_entry", { groupId: G, segment: 1, role: "tool" });
  assert.deepEqual(all.map((e) => (e.content[0] as any).text), ["现在在睡前整理，不往群里说话", "记下了"]);

  await say("我回来了");
  await runtime.wake(G);
  const after = await log.entries(G);
  assert.match((after[1].content[0] as any).text, /\[m2\] 小林#a1 .*: 我回来了/, "numbering continues after the segment break");
  await app.stop();
});

test("a sleep that does not end with the two sections leaves the log alone", async () => {
  const { app, log, runtime, say, segmentStarts } = await setup([reply([], { content: "睡了" })]);
  await say("早");
  await assert.rejects(runtime.requestSleep(G), /没有按【群速写】【交接】格式收尾/);
  assert.equal(await log.currentSegment(G), 1);
  assert.deepEqual(segmentStarts, []);
  await app.stop();
});

test("small logs are not consolidated", async () => {
  const { app, runtime, requests, say } = await setup([], { sleep: { minTokens: 10_000 } });
  await say("早");
  await runtime.requestSleep(G);
  assert.equal(requests.length, 0);
  await app.stop();
});

test("a log over the size limit sleeps right after the wake", async () => {
  const { app, log, runtime, say } = await setup([reply(), finish()], { sleep: { compactTokens: 1 } });
  await say("早");
  await runtime.wake(G);
  assert.equal(await log.currentSegment(G), 2);
  await app.stop();
});

test("a quiet group goes to sleep after the idle time", async () => {
  const { app, log, runtime, say } = await setup([reply(), finish()], { sleep: { idleMs: 20 } });
  await say("早");
  await runtime.wake(G);
  runtime.noteActivity(G);
  await new Promise((r) => setTimeout(r, 80));
  await runtime.wake(G); // waits for the running sleep; no new messages, so no extra model call
  assert.equal(await log.currentSegment(G), 2);
  runtime.dispose();
  await app.stop();
});

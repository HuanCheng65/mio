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
import { AgentRuntime } from "../src/agent/runtime";
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

async function setup(script: AgentStep[], options: { maxSteps?: number; tools?: AgentTool[]; onStep?: (n: number) => Promise<void> } = {}) {
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
  const runtime = new AgentRuntime(log, llm as any, tools, {
    model: { providerId: "p", modelName: "m", maxTokens: 100 },
    maxSteps: options.maxSteps ?? 6,
    systemPrompt: "SYSTEM",
    isShadow: () => false,
  }, quiet);

  let n = 0;
  const say = (text: string) => {
    const id = `p${++n}`;
    const msg: NormalizedMessage = { id, sender: "小林", senderId: "U1", isBot: false, timestamp: Date.now(), segments: [{ type: "text", content: text }], mentions: [] };
    return events.append(G, async () => ({ kind: "message", platformMessageId: id, userId: "U1", isBot: false, timestamp: msg.timestamp, body: msg }));
  };
  return { app, log, runtime, requests, ran, errors, say };
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

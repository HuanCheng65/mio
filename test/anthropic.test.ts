import test from "node:test";
import assert from "node:assert/strict";
import { anthropicPromptDigest, anthropicThinking, buildAnthropicRequest, parseAnthropicResponse, validateAnthropicModel } from "../src/agent/anthropic";
import { AgentLLM } from "../src/agent/llm";
import type { ChatMessage } from "../src/agent/log-store";
import type { ToolDefinition } from "../src/agent/tools";
import type { AgentModelConfig } from "../src/agent/models";
import { ProviderManager, type ProviderConfig } from "../src/llm/provider";

const model: AgentModelConfig = { providerId: "claude", modelName: "claude-sonnet-5-5", maxTokens: 4096, cacheTtlMinutes: 60, reasoning: { mode: "off" } };
const provider: ProviderConfig = { id: "claude", name: "Claude", type: "anthropic", apiKey: "k", images: { transport: "inline", maxPixels: 1_150_000, inlineBudgetMiB: 20 } };
const tools: ToolDefinition[] = [
  { type: "function", function: { name: "say", description: "说话", parameters: { type: "object", properties: { text: { type: "string" } } } } },
  { type: "function", function: { name: "note", description: "记下", parameters: { type: "object" } } },
];
const system = { role: "system" as const, content: "SYSTEM" };
const CACHE = { type: "ephemeral", ttl: "1h" };
const digest = anthropicPromptDigest("SYSTEM", tools);

const rawTurn = [
  { type: "thinking", thinking: "", signature: "sig-empty" },
  { type: "thinking", thinking: "先记一下", signature: "sig-2" },
  { type: "tool_use", id: "toolu_1", name: "note", input: { text: "a" } },
  { type: "tool_use", id: "toolu_2", name: "say", input: { text: "早" } },
] as any;

function withoutCacheControl(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, v) => (key === "cache_control" ? undefined : v)));
}

test("system, tools and the conversation are converted with 1h cache breakpoints on system and the last two user turns", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: [{ type: "text", text: "早" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }] },
    { role: "assistant", content: null, tool_calls: [], anthropicContent: rawTurn, promptDigest: digest },
    { role: "tool", tool_call_id: "toolu_1", content: "记下了" },
    { role: "tool", tool_call_id: "toolu_2", content: "发出去了" },
    { role: "user", content: "新消息" },
  ];
  const request = buildAnthropicRequest([system, ...messages], tools, model);

  assert.deepEqual(request.system, [{ type: "text", text: "SYSTEM", cache_control: CACHE }]);
  assert.deepEqual(request.tools, [
    { name: "say", description: "说话", input_schema: { type: "object", properties: { text: { type: "string" } } } },
    { name: "note", description: "记下", input_schema: { type: "object" } },
  ]);
  assert.deepEqual(request.messages, [
    { role: "user", content: [{ type: "text", text: "早" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }] },
    { role: "assistant", content: rawTurn },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: "记下了" },
      { type: "tool_result", tool_use_id: "toolu_2", content: "发出去了", cache_control: CACHE },
    ] },
    { role: "user", content: [{ type: "text", text: "新消息", cache_control: CACHE }] },
  ]);
  assert.deepEqual(rawTurn[0], { type: "thinking", thinking: "", signature: "sig-empty" }, "stored blocks are not touched");
  assert.equal(request.tool_choice, undefined);
  assert.equal((request as any).temperature, undefined);
  assert.deepEqual(request.thinking, { type: "between_tools" });
  assert.deepEqual(request.betas, ["server-side-fallback-2026-07-01", "mid-conversation-system-clear-at-2026-08-21"]);
  assert.equal(request.fallbacks, "default");
});

test("each later request extends the previous one (ignoring where the breakpoint sits)", () => {
  const first: ChatMessage[] = [{ role: "user", content: "早" }];
  const second: ChatMessage[] = [
    ...first,
    { role: "assistant", content: null, anthropicContent: rawTurn, promptDigest: digest },
    { role: "tool", tool_call_id: "toolu_1", content: "记下了" },
    { role: "tool", tool_call_id: "toolu_2", content: "发出去了" },
  ];
  const third: ChatMessage[] = [...second, { role: "user", content: "又来了" }];
  const requests = [first, second, third].map((m) => withoutCacheControl(buildAnthropicRequest([system, ...m], tools, model)) as any);
  for (let i = 1; i < requests.length; i++) {
    assert.deepEqual(requests[i].system, requests[i - 1].system);
    assert.deepEqual(requests[i].tools, requests[i - 1].tools);
    assert.deepEqual(requests[i].messages.slice(0, requests[i - 1].messages.length), requests[i - 1].messages);
  }

  // 每个请求最后一个断点的位置，下一个请求也在那里打了断点：新增的块再多，也能对上上次写下的缓存
  const raw = [first, second, third].map((m) => buildAnthropicRequest([system, ...m], tools, model).messages);
  for (let i = 1; i < raw.length; i++) {
    const previousLast = raw[i - 1].length - 1;
    assert.deepEqual((raw[i][previousLast].content as any[]).at(-1).cache_control, CACHE);
  }
});

test("assistant entries from an OpenAI-compatible model are rebuilt; empty turns are always left out", () => {
  const request = buildAnthropicRequest([
    system,
    { role: "user", content: "早" },
    { role: "assistant", content: null },
    { role: "user", content: "在吗" },
    {
      role: "assistant",
      content: "在",
      reasoning_content: "想想",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "note", arguments: "{\"text\":\"a\\/b\"}" } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "记下了" },
  ], tools, model);

  assert.deepEqual(request.messages.map((m) => m.role), ["user", "user", "assistant", "user"]);
  assert.deepEqual(request.messages[2].content, [
    { type: "text", text: "在" },
    { type: "tool_use", id: "call_1", name: "note", input: { text: "a/b" } },
  ]);
  assert.throws(() => buildAnthropicRequest([
    system,
    { role: "user", content: "早" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_2", type: "function", function: { name: "note", arguments: "{oops" } }] },
    { role: "tool", tool_call_id: "call_2", content: "x" },
  ], tools, model), /call_2 的参数不是合法 JSON/);
});

test("thinking minted under an older persona or tool set is dropped from the oldest turn up to the last stale one", () => {
  const blocks = (n: number) => [
    { type: "thinking", thinking: `想${n}`, signature: `sig-${n}` },
    { type: "tool_use", id: `toolu_${n}`, name: "note", input: {} },
  ] as any;
  const turn = (n: number, promptDigest?: string): ChatMessage[] => [
    { role: "assistant", content: null, anthropicContent: blocks(n), ...(promptDigest ? { promptDigest } : {}) },
    { role: "tool", tool_call_id: `toolu_${n}`, content: "ok" },
  ];
  const assistantTurns = (request: ReturnType<typeof buildAnthropicRequest>) =>
    request.messages.filter((m) => m.role === "assistant").map((m) => (m.content as any[]).map((b) => b.type).join("+"));

  // 1 是改功能之前的条目（没有指纹），2 在旧人设下，3 在现在的人设下
  const history = [{ role: "user", content: "早" } as ChatMessage, ...turn(1), ...turn(2, "old"), ...turn(3, digest)];
  assert.deepEqual(assistantTurns(buildAnthropicRequest([system, ...history], tools, model)), ["tool_use", "tool_use", "thinking+tool_use"]);

  // 人设又改回去：旧人设下的 2 指纹又对上了，但 3 是在 2 去掉思考块之后生成的，放回去会让 3 失效，所以照样去掉
  const reverted = [{ role: "user", content: "早" } as ChatMessage, ...turn(1), ...turn(2, digest), ...turn(3, "newer"), ...turn(4, digest)];
  assert.deepEqual(assistantTurns(buildAnthropicRequest([system, ...reverted], tools, model)), ["tool_use", "tool_use", "tool_use", "thinking+tool_use"]);

  // 人设改了：所有思考块都去掉；log 里存的块不动
  const changed = buildAnthropicRequest([{ role: "system", content: "SYSTEM v2" }, ...history], tools, model);
  assert.deepEqual(assistantTurns(changed), ["tool_use", "tool_use", "tool_use"]);
  assert.equal((history[5] as any).anthropicContent[0].type, "thinking");

  // 工具定义变了也一样
  const retooled = buildAnthropicRequest([system, ...history], [tools[0]], model);
  assert.deepEqual(assistantTurns(retooled), ["tool_use", "tool_use", "tool_use"]);

  // 只有思考块的一步去掉之后是空的：连同它前面的提醒一起省略
  const thinkingOnly: ChatMessage[] = [
    { role: "user", content: "早" },
    { role: "reminder", content: "提醒" },
    { role: "assistant", content: null, anthropicContent: [blocks(5)[0]], promptDigest: "old" },
    { role: "user", content: "在吗" },
  ];
  assert.deepEqual(withoutCacheControl(buildAnthropicRequest([system, ...thinkingOnly], tools, model).messages), [
    { role: "user", content: [{ type: "text", text: "早" }] },
    { role: "user", content: [{ type: "text", text: "在吗" }] },
  ]);
});

test("requests that Anthropic cannot take fail loudly", () => {
  assert.throws(() => buildAnthropicRequest([system, { role: "user", content: "早" }, { role: "assistant", content: "嗯" }], tools, model), /最后一条必须是 user/);
  assert.throws(() => buildAnthropicRequest([{ role: "user", content: "早" }], tools, model), /第一条消息必须是 system/);
});

test("images uploaded through the Files API are referenced by file_id", () => {
  const request = buildAnthropicRequest([system, { role: "user", content: [{ type: "text", text: "看" }, { type: "file", file_id: "file_011" }] }], tools, model);
  assert.deepEqual(withoutCacheControl(request.messages), [
    { role: "user", content: [{ type: "text", text: "看" }, { type: "image", source: { type: "file", file_id: "file_011" } }] },
  ]);
  validateAnthropicModel({ ...provider, images: { transport: "anthropic-files", maxPixels: 1 } }, model);
});

test("reasoning settings map onto thinking and effort", () => {
  const at = (reasoning: ModelConfig["reasoning"]) => anthropicThinking({ ...model, reasoning });
  assert.deepEqual(at(undefined), {});
  assert.deepEqual(at({ mode: "auto" }), {});
  assert.deepEqual(at({ mode: "off" }), { thinking: { type: "between_tools" } });
  assert.deepEqual(at({ mode: "off", effort: "low" }), { thinking: { type: "between_tools" }, output_config: { effort: "low" } });
  assert.deepEqual(at({ mode: "effort", effort: "high" }), { thinking: { type: "adaptive" }, output_config: { effort: "high" } });
  assert.throws(() => at({ mode: "budget", budgetTokens: 2000 }), /不支持 budget/);
  assert.throws(() => at({ mode: "effort", effort: "minimal" }), /没有 minimal/);
  assert.throws(() => at({ mode: "effort" }), /需要设 effort/);
  assert.throws(() => at({ mode: "off", effort: "max" }), /最高只能是 high/);
});

test("reminders become turn-scoped system messages that stay in place; the breakpoint stays on the last user turn", () => {
  const reminder = { role: "reminder" as const, content: "〔提醒〕" };
  const turnScoped = { role: "system", clear_at: "next_user_message", content: "〔提醒〕" };
  const first: ChatMessage[] = [{ role: "user", content: "早" }, reminder];
  const second: ChatMessage[] = [
    { role: "user", content: "早" }, reminder,
    { role: "assistant", content: null, tool_calls: [], anthropicContent: rawTurn, promptDigest: digest },
    { role: "tool", tool_call_id: "toolu_1", content: "记下了" },
    { role: "tool", tool_call_id: "toolu_2", content: "发出去了" },
    reminder,
  ];
  const a = buildAnthropicRequest([system, ...first], tools, model).messages;
  const b = buildAnthropicRequest([system, ...second], tools, model).messages;
  assert.deepEqual(a, [{ role: "user", content: [{ type: "text", text: "早", cache_control: CACHE }] }, turnScoped]);
  assert.deepEqual(withoutCacheControl(b.slice(0, a.length)), withoutCacheControl(a), "the earlier reminder is sent back where it was");
  assert.deepEqual(b.at(-1), turnScoped);
  assert.deepEqual((b.at(-2) as any).content.at(-1).cache_control, CACHE);

  assert.throws(() => buildAnthropicRequest([system, reminder], tools, model), /前面必须是 user 消息/);
  assert.throws(() => buildAnthropicRequest([system, { role: "user", content: "早" }, reminder, { role: "user", content: "午" }], tools, model), /后面紧跟着 user 消息/);
});

test("model settings Anthropic rejects are caught at startup", () => {
  validateAnthropicModel(provider, model);
  assert.throws(() => validateAnthropicModel(provider, { ...model, cacheTtlMinutes: 5 }), /cacheTtlMinutes 只能是 60/);
  assert.throws(() => validateAnthropicModel(provider, { ...model, temperature: 0.7 }), /不能设 temperature/);
  assert.throws(() => validateAnthropicModel(provider, { ...model, extraBody: { top_k: 5 } }), /不支持 extraBody/);
  assert.throws(() => validateAnthropicModel({ ...provider, images: { transport: "deepseek-files", maxPixels: 1 } }, model), /只能用 inline 或 anthropic-files/);
});

const response = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content,
  stop_reason: "tool_use",
  stop_details: null,
  usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90, output_tokens: 20 },
  ...extra,
}) as any;

test("responses keep their raw blocks, tool inputs become JSON arguments, usage counts cache", () => {
  const parsed = parseAnthropicResponse(response([{ type: "text", text: "嗯", citations: null }, ...rawTurn]), model);
  assert.equal(parsed.content, "嗯");
  assert.deepEqual(parsed.toolCalls, [
    { id: "toolu_1", type: "function", function: { name: "note", arguments: "{\"text\":\"a\"}" } },
    { id: "toolu_2", type: "function", function: { name: "say", arguments: "{\"text\":\"早\"}" } },
  ]);
  assert.deepEqual(parsed.anthropicContent, [{ type: "text", text: "嗯", citations: null }, ...rawTurn]);
  assert.deepEqual(parsed.usage, { promptTokens: 1000, completionTokens: 20, cachedTokens: 900, cacheWriteTokens: 90 });

  const fallback = { type: "fallback", from: { model: "claude-sonnet-5-5" }, to: { model: "claude-sonnet-5" }, trigger: { type: "refusal", category: "cyber" } };
  const afterFallback = parseAnthropicResponse(response([fallback, { type: "text", text: "好" }], { stop_reason: "end_turn" }), model);
  assert.deepEqual(afterFallback.anthropicContent[0], fallback);
});

test("refusals, truncation and unexpected output fail loudly", () => {
  assert.throws(
    () => parseAnthropicResponse(response([], { stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } }), model),
    /拒绝了这次请求.*cyber/,
  );
  assert.throws(() => parseAnthropicResponse(response([], { stop_reason: "max_tokens" }), model), /maxTokens \(4096\) 被截断/);
  assert.throws(() => parseAnthropicResponse(response([], { stop_reason: "pause_turn" }), model), /pause_turn/);
  assert.throws(() => parseAnthropicResponse(response([{ type: "server_tool_use", id: "s", name: "web_search", input: {} }]), model), /server_tool_use/);
  const fallback = { type: "fallback", from: { model: "a" }, to: { model: "b" }, trigger: null };
  assert.throws(() => parseAnthropicResponse(response([rawTurn[1], fallback, { type: "text", text: "好" }]), model), /fallback 块之前/);
});

test("the agent step goes to the provider's own API; raw Anthropic blocks never reach an OpenAI-compatible one", async () => {
  const deepseek: ProviderConfig = { id: "deepseek", name: "DeepSeek", type: "openai", apiKey: "k", dialect: "deepseek" };
  const providers = new ProviderManager([provider, deepseek]);
  const sentToAnthropic: any[] = [];
  const sentToOpenAI: any[] = [];
  (providers.getAnthropicProvider("claude") as any).beta.messages.create = async (params: unknown) => {
    sentToAnthropic.push(params);
    return response(rawTurn);
  };
  (providers.getOpenAIProvider("deepseek") as any).chat.completions.create = async (body: unknown) => {
    sentToOpenAI.push(body);
    return { choices: [{ finish_reason: "stop", message: { content: "嗯" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } };
  };
  const llm = new AgentLLM(providers);
  const history: ChatMessage[] = [
    { role: "user", content: "早" },
    { role: "assistant", content: null, tool_calls: [], anthropicContent: rawTurn, promptDigest: digest },
    { role: "user", content: "在吗" },
  ];

  const step = await llm.step([system, ...history], tools, model);
  assert.equal(sentToAnthropic.length, 1);
  assert.deepEqual(sentToAnthropic[0].messages[1], { role: "assistant", content: rawTurn });
  assert.deepEqual(step.anthropicContent, rawTurn);
  assert.equal(step.promptDigest, digest);
  assert.equal(step.usage.cacheWriteTokens, 90);

  await llm.step([system, ...history], tools, { providerId: "deepseek", modelName: "deepseek-flash", maxTokens: 100 });
  assert.deepEqual(sentToOpenAI[0].messages[2], { role: "assistant", content: null, tool_calls: [] });
  assert.ok(!JSON.stringify(sentToOpenAI[0]).includes("sig-empty"));
});

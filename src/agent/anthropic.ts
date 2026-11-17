import { createHash } from "node:crypto";
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaTextBlockParam,
  BetaThinkingConfigParam,
  BetaTool,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ModelConfig, ProviderConfig } from "../llm/provider";
import type { ChatMessage, ToolCall } from "./log-store";
import type { SystemMessage } from "./llm";
import type { AgentModelConfig } from "./models";
import type { ToolDefinition } from "./tools";

/**
 * 原生 Anthropic Messages API 的请求构造和响应解析（纯函数，不碰网络）。
 *
 * 缓存是前缀匹配，顺序 tools → system → messages。三个断点：system 上一个（缓存 tools + system），
 * 最后两条 user 消息的最后一块上各一个（见 addMessageBreakpoints）。群里两次调用常隔 5–60 分钟，所以用 1 小时 TTL。
 * 思考块（含签名）由 log 原样保存、原样发回，history 只追加，前面的思考块才一直有效。
 * 签名还绑定了生成它时的 system 和 tools：改了人设或工具定义，之前的思考块就会被拒（见 stripStaleThinking）。
 * 图片不在其中：每张图按第一次发出时的设置发（image-transport.ts 的 PinnedImageTransport），改配置不影响旧图。
 *
 * 说话提醒是只管一轮的 system 消息（clear_at: next_user_message）：之后有新的 user 消息（包括工具结果）
 * 就不再显示、不再计费，但每次都原样留在原位，前缀不变。
 */

const CACHE = { type: "ephemeral", ttl: "1h" } as const;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const CLEAR_AT_BETA = "mid-conversation-system-clear-at-2026-08-21";

/** 把 ModelConfig.reasoning 翻译成 thinking / output_config；不支持的组合直接报错 */
export function anthropicThinking(model: ModelConfig): Pick<MessageCreateParamsNonStreaming, "thinking" | "output_config"> {
  const reasoning = model.reasoning;
  const effort = reasoning?.effort;
  if (effort === "minimal") throw new Error(`${model.modelName}: Anthropic 没有 minimal 这一档 effort`);
  const outputConfig = effort ? { output_config: { effort } } : {};
  switch (reasoning?.mode ?? "auto") {
    case "auto":
      if (effort) throw new Error(`${model.modelName}: reasoning.mode=auto 时不要设 effort（要设 effort 请用 mode=effort）`);
      return {};
    case "off":
      // Sonnet 5.5 不接受 disabled，关思考只能用 between_tools，且 effort 只能到 high
      if (effort === "max") throw new Error(`${model.modelName}: 关思考（between_tools）时 effort 最高只能是 high`);
      return { thinking: { type: "between_tools" } as BetaThinkingConfigParam, ...outputConfig };
    case "effort":
      if (!effort) throw new Error(`${model.modelName}: reasoning.mode=effort 需要设 effort`);
      return { thinking: { type: "adaptive" }, ...outputConfig };
    case "budget":
      throw new Error(`${model.modelName}: Anthropic 不支持 budget 推理模式（budgetTokens 会被拒绝），请用 effort`);
  }
}

/** 启动时检查 Anthropic 模型配置；不合格就抛错 */
export function validateAnthropicModel(provider: ProviderConfig, model: AgentModelConfig): void {
  if (!model.maxTokens) throw new Error(`${model.modelName}: 没有设置 maxTokens`);
  // 只用 1 小时 TTL：5 分钟的缓存撑不过群里常见的间隔，按"快过期就睡"也会几乎每次唤醒后都睡
  if (model.cacheTtlMinutes !== 60) throw new Error(`${model.modelName}: Anthropic 模型的 cacheTtlMinutes 只能是 60（1 小时 TTL）`);
  if (model.temperature !== undefined) throw new Error(`${model.modelName}: Anthropic 模型不能设 temperature（非默认值会被拒绝）`);
  if (Object.keys(provider.extraBody ?? {}).length > 0 || Object.keys(model.extraBody ?? {}).length > 0) {
    throw new Error(`${model.modelName}: Anthropic 供应商不支持 extraBody`);
  }
  const transport = provider.images?.transport;
  if (transport !== "inline" && transport !== "anthropic-files") {
    throw new Error(`供应商 ${provider.id}: Anthropic 只能用 inline 或 anthropic-files 发图（现在是 ${transport}）`);
  }
  anthropicThinking(model);
}

function userBlocks(content: Extract<ChatMessage, { role: "user" }>["content"]): BetaContentBlockParam[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part): BetaContentBlockParam => {
    if (part.type === "text") return { type: "text", text: part.text };
    // anthropic-files 发图给出的 file_id；part 是请求时按当前供应商生成的，不会混进别家的 id
    if (part.type === "file") return { type: "image", source: { type: "file", file_id: part.file_id } };
    // inline 发图给出的是我们自己拼的 data URL
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(part.image_url.url);
    if (!match) throw new Error(`无法转成 Anthropic 图片块的 image_url: ${part.image_url.url.slice(0, 40)}`);
    return { type: "image", source: { type: "base64", media_type: match[1] as "image/png", data: match[2] } };
  });
}

/** 没有原始块的 assistant 条目（这一段之前用的是 OpenAI 兼容模型）：用文字和工具调用重建；reasoning_content 发不回去，丢掉 */
function rebuiltAssistantBlocks(message: Extract<ChatMessage, { role: "assistant" }>): BetaContentBlockParam[] {
  const blocks: BetaContentBlockParam[] = message.content ? [{ type: "text", text: message.content }] : [];
  for (const call of message.tool_calls ?? []) {
    let input: unknown;
    try {
      input = JSON.parse(call.function.arguments || "{}");
    } catch {
      throw new Error(`工具调用 ${call.id} 的参数不是合法 JSON，无法转成 Anthropic 的 tool_use: ${call.function.arguments}`);
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new Error(`工具调用 ${call.id} 的参数不是 JSON 对象，无法转成 Anthropic 的 tool_use: ${call.function.arguments}`);
    }
    blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input });
  }
  return blocks;
}

function anthropicTools(tools: ToolDefinition[]): BetaTool[] {
  return tools.map((t): BetaTool => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters as BetaTool["input_schema"],
  }));
}

/** 思考块签名绑定的前缀里，不在 log 里的那部分（system 和 tools）的指纹；随 assistant 条目存进 log */
export function anthropicPromptDigest(system: string, tools: ToolDefinition[]): string {
  return createHash("sha256").update(JSON.stringify({ system, tools: anthropicTools(tools) })).digest("hex");
}

const THINKING = new Set(["thinking", "redacted_thinking"]);

/**
 * 思考块的签名绑定了生成它时的前缀，之后改了人设或工具定义再原样发回，API 会以
 * "属于另一个对话"拒绝整个请求，而且这一段之后每次都会被拒。Sonnet 5.5 关思考（between_tools）时
 * 不支持 block_binding 的 drop_block，只能自己去掉。
 * API 允许从最早的开始去掉一串思考块，但不允许去掉中间的、也不允许去掉后再放回去，所以规则是：
 * 找到最后一条指纹和现在不一样（或没有指纹）的条目，它和它之前所有条目的思考块都去掉。
 * 之后只要这几样不再变，每次去掉的都是同一批，前缀稳定。
 */
function stripStaleThinking(messages: ChatMessage[], digest: string): ChatMessage[] {
  let stale = -1;
  messages.forEach((m, i) => {
    if (m.role === "assistant" && m.anthropicContent && m.promptDigest !== digest) stale = i;
  });
  return messages.map((m, i) => {
    if (i > stale || m.role !== "assistant" || !m.anthropicContent) return m;
    return { ...m, anthropicContent: m.anthropicContent.filter((b) => !THINKING.has(b.type)) };
  });
}

/**
 * 断点打在最后两条 user 消息的最后一块上（只管一轮的 system 消息不能带 cache_control）。
 * 查缓存时，每个断点只往前找 20 个块。新的一批消息里图多（一张图一个块）时，最后一个断点离上次请求
 * 写下的缓存会超过 20 块，整段就会按写入价重写。上次请求的最后一条 user 消息就是这次的倒数第二条，
 * 在那里也打一个断点，正好对上上次写下的位置。
 */
function addMessageBreakpoints(out: BetaMessageParam[]): void {
  const users = out.filter((m) => m.role === "user").slice(-2);
  for (const message of users) {
    const content = message.content as BetaContentBlockParam[];
    // 换成新对象，不改动 log 里原样保存的块
    content[content.length - 1] = { ...content[content.length - 1], cache_control: CACHE } as BetaContentBlockParam;
  }
}

/** OpenAI 形状的消息 → Anthropic 请求。第一条必须是 system，最后一条必须是 user（不能预填 assistant）。 */
export function buildAnthropicRequest(
  messages: (SystemMessage | ChatMessage)[],
  tools: ToolDefinition[],
  model: ModelConfig,
): MessageCreateParamsNonStreaming {
  const [system, ...rest] = messages;
  if (system?.role !== "system") throw new Error("Anthropic 请求的第一条消息必须是 system");
  if (rest.some((m) => m.role === "system")) throw new Error("Anthropic 请求只支持开头一条 system 消息");

  const out: BetaMessageParam[] = [];
  for (const message of stripStaleThinking(rest as ChatMessage[], anthropicPromptDigest(system.content, tools))) {
    switch (message.role) {
      case "reminder": {
        // 只能接在 user 消息（含工具结果）后面；后面紧跟 user 消息会被拒绝，在下面检查
        if (out.at(-1)?.role !== "user") throw new Error("说话提醒前面必须是 user 消息或工具结果");
        out.push({ role: "system", clear_at: "next_user_message", content: message.content } as unknown as BetaMessageParam);
        break;
      }
      case "user":
        out.push({ role: "user", content: userBlocks(message.content) });
        break;
      case "assistant": {
        // 有原始块就原样发回（思考块和签名、fallback 块都不动）
        const blocks = message.anthropicContent
          ? (message.anthropicContent as unknown as BetaContentBlockParam[])
          : rebuiltAssistantBlocks(message);
        // 什么都没说的一步：API 不接受空 content 的 assistant 消息，固定省略（每次都省略，前缀不变）
        if (blocks.length > 0) {
          out.push({ role: "assistant", content: blocks });
        } else if ((out.at(-1)?.role as string) === "system") {
          // 只有思考块的一步去掉思考块后也是空的。runtime 只给有内容的一步写提醒，所以这里的提醒是那一步的，
          // 一起省略，否则提醒后面会紧跟 user 消息。这一步在去掉思考块的那一串里，每次都同样省略
          out.pop();
        }
        break;
      }
      case "tool": {
        // 同一轮的所有工具结果放进同一条 user 消息
        const result: BetaContentBlockParam = { type: "tool_result", tool_use_id: message.tool_call_id, content: message.content };
        const last = out.at(-1);
        const lastBlocks = last?.role === "user" && Array.isArray(last.content) ? last.content : undefined;
        if (lastBlocks && lastBlocks.length > 0 && lastBlocks.every((b) => b.type === "tool_result")) lastBlocks.push(result);
        else out.push({ role: "user", content: [result] });
        break;
      }
    }
  }

  const roles = out.map((m) => m.role as string);
  const stray = roles.findIndex((role, i) => role === "system" && roles[i + 1] === "user");
  if (stray >= 0) throw new Error(`第 ${stray + 1} 条消息是说话提醒，后面紧跟着 user 消息（中间少了 assistant 回合），Anthropic 会拒绝`);
  const lastRole = roles.at(-1);
  if (lastRole !== "user" && lastRole !== "system") throw new Error("Anthropic 请求的最后一条必须是 user 消息或说话提醒（不支持 assistant 预填）");
  addMessageBreakpoints(out);

  return {
    model: model.modelName,
    max_tokens: model.maxTokens!,
    system: [{ type: "text", text: system.content, cache_control: CACHE } satisfies BetaTextBlockParam],
    tools: anthropicTools(tools),
    messages: out,
    ...anthropicThinking(model),
    betas: [FALLBACK_BETA, CLEAR_AT_BETA],
    fallbacks: "default",
  };
}

export interface ParsedAnthropicStep {
  content: string;
  toolCalls: ToolCall[];
  anthropicContent: BetaContentBlock[];
  usage: { promptTokens: number; completionTokens: number; cachedTokens: number; cacheWriteTokens: number };
}

const KNOWN_BLOCKS = new Set(["text", "thinking", "redacted_thinking", "tool_use", "fallback"]);

/** 解析响应；拒绝、截断和意料之外的停止原因都直接报错 */
export function parseAnthropicResponse(response: BetaMessage, model: ModelConfig): ParsedAnthropicStep {
  switch (response.stop_reason) {
    case "end_turn":
    case "tool_use":
      break;
    case "refusal":
      throw new Error(
        `${response.model} 拒绝了这次请求（server-side fallback 之后仍是拒绝），类别 ${response.stop_details?.category ?? "未分类"}`
        + `${response.stop_details?.explanation ? `：${response.stop_details.explanation}` : ""}`,
      );
    case "max_tokens":
      throw new Error(`${model.modelName} 输出因达到 maxTokens (${model.maxTokens}) 被截断，请调大 agent 模型的 maxTokens`);
    default:
      throw new Error(`${response.model} 以意料之外的 stop_reason 结束: ${response.stop_reason}`);
  }

  const unknown = response.content.find((b) => !KNOWN_BLOCKS.has(b.type));
  if (unknown) throw new Error(`${response.model} 返回了无法处理的内容块: ${unknown.type}`);
  // 回传规则要求省掉最后一个 fallback 块之前的思考块和工具调用；非流式请求本来就不带被拒绝的那部分，出现了说明假设不成立
  const lastFallback = response.content.map((b) => b.type).lastIndexOf("fallback");
  const beforeFallback = response.content.slice(0, Math.max(lastFallback, 0));
  if (beforeFallback.some((b) => b.type === "thinking" || b.type === "redacted_thinking" || b.type === "tool_use")) {
    throw new Error(`${response.model} 的响应在 fallback 块之前有思考块或工具调用，不能原样保存回放`);
  }

  const toolCalls: ToolCall[] = response.content.flatMap((b) => (b.type === "tool_use"
    ? [{ id: b.id, type: "function" as const, function: { name: b.name, arguments: JSON.stringify(b.input) } }]
    : []));
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");

  const usage = response.usage;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return {
    content: text,
    toolCalls,
    anthropicContent: response.content,
    usage: {
      promptTokens: usage.input_tokens + cacheRead + cacheWrite,
      completionTokens: usage.output_tokens,
      cachedTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    },
  };
}

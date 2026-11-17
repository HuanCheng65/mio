import type { BetaContentBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ModelConfig, ProviderManager } from "../llm/provider";
import { buildOpenAIReasoningBody } from "../llm/reasoning";
import { tokenTracker } from "../llm/token-tracker";
import { buildAnthropicRequest, parseAnthropicResponse } from "./anthropic";
import type { ChatMessage, ToolCall } from "./log-store";
import type { ToolDefinition } from "./tools";

export interface AgentStep {
  content: string;
  /** 思考模式的推理内容；原样存进 log、下次原样发回，前缀才稳定 */
  reasoning: string | null;
  toolCalls: ToolCall[];
  /** Anthropic 模型的响应 content 原样（含思考块和签名），存进 log 原样发回；其他供应商为 null */
  anthropicContent: BetaContentBlock[] | null;
  /** cacheWriteTokens：写入缓存的 token（只有 Anthropic 单独报告，其他供应商为 0） */
  usage: { promptTokens: number; completionTokens: number; cachedTokens: number; cacheWriteTokens: number };
}

export type SystemMessage = { role: "system"; content: string };

/**
 * OpenAI 兼容接口没有"只管一轮"的消息：只有请求末尾这次要发的提醒有效，拼到最近一批消息后面；
 * 发过的提醒都不发（和 Anthropic 上清掉的提醒一样看不到）。anthropicContent 不是 OpenAI 的字段，去掉。
 */
export function toOpenAIMessages(messages: (SystemMessage | ChatMessage)[]): unknown[] {
  const last = messages.at(-1);
  const pending = last?.role === "reminder" ? last.content : null;
  const out: (SystemMessage | ChatMessage)[] = [];
  for (const m of messages) {
    if (m.role === "reminder") continue;
    if (m.role === "assistant" && m.anthropicContent) {
      const { anthropicContent: _, ...rest } = m;
      out.push(rest);
    } else {
      out.push(m);
    }
  }
  if (pending !== null) {
    const index = out.map((m) => m.role).lastIndexOf("user");
    if (index < 0) throw new Error("说话提醒找不到可以拼接的 user 消息");
    const message = out[index] as Extract<ChatMessage, { role: "user" }>;
    out[index] = typeof message.content === "string"
      ? { role: "user", content: `${message.content}\n${pending}` }
      : { role: "user", content: [...message.content, { type: "text", text: pending }] };
  }
  return out;
}

/** agent 的单步调用（带工具）。按模型的供应商类型走 OpenAI 兼容接口或原生 Anthropic 接口。 */
export class AgentLLM {
  constructor(private providers: ProviderManager) {}

  async step(messages: (SystemMessage | ChatMessage)[], tools: ToolDefinition[], model: ModelConfig): Promise<AgentStep> {
    const providerConfig = this.providers.getProviderConfig(model.providerId);
    if (!providerConfig) throw new Error(`agent 模型的供应商不存在: ${model.providerId}`);
    if (!model.maxTokens) throw new Error(`agent 模型 ${model.modelName} 没有设置 maxTokens`);
    if (providerConfig.type === "anthropic") return this.stepAnthropic(messages, tools, model);

    const client = this.providers.getOpenAIProvider(model.providerId);
    if (providerConfig.type !== "openai" || !client) {
      throw new Error(`agent 模型需要 OpenAI 兼容或 Anthropic 的供应商: ${model.providerId}`);
    }

    const body: Record<string, unknown> = {
      model: model.modelName,
      messages: toOpenAIMessages(messages),
      tools,
      max_tokens: model.maxTokens,
      ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
      ...buildOpenAIReasoningBody(providerConfig, model),
      ...providerConfig.extraBody,
      ...model.extraBody,
    };
    const response = await client.chat.completions.create(body as never);
    const choice = response.choices[0];
    if (choice.finish_reason === "length") {
      throw new Error(`${model.modelName} 输出因达到 maxTokens (${model.maxTokens}) 被截断，请调大 agent 模型的 maxTokens`);
    }

    const message = choice.message as typeof choice.message & { reasoning_content?: string };
    const usage = {
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      cachedTokens: response.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWriteTokens: 0,
    };
    tokenTracker.record(model.modelName, usage.promptTokens, usage.completionTokens, usage.cachedTokens, "agent");

    return {
      content: message.content ?? "",
      reasoning: message.reasoning_content ?? null,
      toolCalls: (message.tool_calls ?? []) as ToolCall[],
      anthropicContent: null,
      usage,
    };
  }

  private async stepAnthropic(messages: (SystemMessage | ChatMessage)[], tools: ToolDefinition[], model: ModelConfig): Promise<AgentStep> {
    const client = this.providers.getAnthropicProvider(model.providerId);
    if (!client) throw new Error(`找不到 Anthropic 供应商的客户端: ${model.providerId}`);
    const response = await client.beta.messages.create(buildAnthropicRequest(messages, tools, model));
    const parsed = parseAnthropicResponse(response, model);
    // 按实际回答的模型记账（server-side fallback 时是备用模型）。promptTokens 含缓存读写，和其他供应商的统计口径一致
    tokenTracker.record(response.model, parsed.usage.promptTokens, parsed.usage.completionTokens, parsed.usage.cachedTokens, "agent");
    return { ...parsed, reasoning: null };
  }
}

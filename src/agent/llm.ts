import type { ModelConfig, ProviderManager } from "../llm/provider";
import { buildOpenAIReasoningBody } from "../llm/reasoning";
import { tokenTracker } from "../llm/token-tracker";
import type { ChatMessage, ToolCall } from "./log-store";
import type { ToolDefinition } from "./tools";

export interface AgentStep {
  content: string;
  /** 思考模式的推理内容；原样存进 log、下次原样发回，前缀才稳定 */
  reasoning: string | null;
  toolCalls: ToolCall[];
  usage: { promptTokens: number; completionTokens: number; cachedTokens: number };
}

export type SystemMessage = { role: "system"; content: string };

/** OpenAI 兼容的单步调用（带工具）。推理参数和 extraBody 的处理与 LLMClient 一致。 */
export class AgentLLM {
  constructor(private providers: ProviderManager) {}

  async step(messages: (SystemMessage | ChatMessage)[], tools: ToolDefinition[], model: ModelConfig): Promise<AgentStep> {
    const providerConfig = this.providers.getProviderConfig(model.providerId);
    const client = this.providers.getOpenAIProvider(model.providerId);
    if (!providerConfig || !client) {
      throw new Error(`agent 模型需要 OpenAI 兼容的供应商，找不到: ${model.providerId}`);
    }
    if (!model.maxTokens) throw new Error(`agent 模型 ${model.modelName} 没有设置 maxTokens`);

    const body: Record<string, unknown> = {
      model: model.modelName,
      messages,
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
    };
    tokenTracker.record(model.modelName, usage.promptTokens, usage.completionTokens, usage.cachedTokens, "agent");

    return {
      content: message.content ?? "",
      reasoning: message.reasoning_content ?? null,
      toolCalls: (message.tool_calls ?? []) as ToolCall[],
      usage,
    };
  }
}

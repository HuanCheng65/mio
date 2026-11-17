import type { Config as MioConfig } from "../config";
import type { ModelConfig, ProviderConfig } from "../llm/provider";
import { validateAnthropicModel } from "./anthropic";

type AgentConfig = MioConfig["agent"];

/** agent 模型配置：在通用模型配置之外，还要知道这个模型的提示缓存能留多久 */
export interface AgentModelConfig extends ModelConfig {
  /**
   * 提示缓存的存活时间（分钟），从最后一次请求开始算。一段 log 空闲到快过期时就睡前整理，
   * 让整理读到缓存、之后从小的一段重新开始，而不是等缓存过期后把整段按写入价重写一遍。
   */
  cacheTtlMinutes: number;
}

/** 睡前整理提前多久开始：整理的第一个请求必须在缓存过期前发出 */
export const SLEEP_MARGIN_MINUTES = 5;

/** 群 → agent 模型：groupModels 里列出的群用自己的，其余用默认 */
export function agentModelFor(agent: Pick<AgentConfig, "model" | "groupModels">): (groupId: string) => AgentModelConfig {
  return (groupId) => agent.groupModels[groupId] ?? agent.model;
}

export interface AgentModelUse {
  /** 日志里怎么称呼这个配置（默认模型或某个群） */
  label: string;
  model: AgentModelConfig;
  provider: ProviderConfig;
}

/**
 * 启动时检查默认模型和每个群覆盖的模型：供应商要存在、有 API Key、是 OpenAI 兼容或 anthropic，
 * 并且模型配置是这个供应商能用的。有问题时返回说明（点名是哪个群），都没问题时返回每个配置用到的供应商。
 */
export function checkAgentModels(agent: Pick<AgentConfig, "model" | "groupModels">, providers: ProviderConfig[]): AgentModelUse[] | string {
  const configs: [string, AgentModelConfig][] = [
    ["默认 agent 模型", agent.model],
    ...Object.entries(agent.groupModels).map(([groupId, model]): [string, AgentModelConfig] => [`群 ${groupId} 的 agent 模型`, model]),
  ];
  const uses: AgentModelUse[] = [];
  for (const [label, model] of configs) {
    const provider = providers.find((p) => p.id === model.providerId);
    if (!provider) return `${label}的供应商 ${model.providerId} 不存在`;
    if (!provider.apiKey) return `${label}的供应商 ${provider.id} 没有 API Key`;
    if (provider.type !== "openai" && provider.type !== "anthropic") {
      return `${label}的供应商 ${provider.id} 是 ${provider.type}，agent 只支持 OpenAI 兼容或 anthropic`;
    }
    if (!model.maxTokens) return `${label}（${model.modelName}）没有设置 maxTokens`;
    if (!(model.cacheTtlMinutes > SLEEP_MARGIN_MINUTES)) {
      return `${label}（${model.modelName}）的 cacheTtlMinutes 是 ${model.cacheTtlMinutes}，要大于睡前整理的提前量 ${SLEEP_MARGIN_MINUTES} 分钟`;
    }
    if (provider.type === "anthropic") {
      // validateAnthropicModel 只会因为配置不合格抛错，这里换成点名群的说明
      try {
        validateAnthropicModel(provider, model);
      } catch (error) {
        return `${label}不合格：${(error as Error).message}`;
      }
    }
    uses.push({ label, model, provider });
  }
  return uses;
}

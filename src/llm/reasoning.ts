import type { GenerateContentConfig } from "@google/genai";
import type { ModelConfig, ProviderConfig } from "./provider";

/**
 * 把 ModelConfig.reasoning 翻译成 OpenAI-compat 请求体片段。
 * 返回值会直接 spread 进 chat.completions.create 的请求体。
 * 不同 dialect 的 reasoning 控制方式差异由这里吸收。
 */
export function buildOpenAIReasoningBody(
  provider: ProviderConfig,
  model: ModelConfig,
): Record<string, any> {
  const reasoning = model.reasoning;
  if (!reasoning || !reasoning.mode || reasoning.mode === "auto") {
    return {};
  }

  const dialect = provider.dialect ?? "openai";

  switch (dialect) {
    case "openai":
    case "openrouter": {
      if (reasoning.mode === "effort" && reasoning.effort) {
        return { reasoning_effort: reasoning.effort };
      }
      if (reasoning.mode === "off") {
        return { reasoning_effort: "minimal" };
      }
      return {};
    }
    case "qwen": {
      if (reasoning.mode === "off") {
        return { enable_thinking: false };
      }
      if (reasoning.mode === "budget") {
        return {
          enable_thinking: true,
          ...(reasoning.budgetTokens !== undefined
            ? { thinking_budget: reasoning.budgetTokens }
            : {}),
        };
      }
      return {};
    }
    case "deepseek": {
      // DeepSeek: thinking 开关走 top-level `thinking.type`，强度走 reasoning_effort
      if (reasoning.mode === "off") {
        return { thinking: { type: "disabled" } };
      }
      if (reasoning.mode === "effort" && reasoning.effort) {
        return {
          reasoning_effort: reasoning.effort,
          thinking: { type: "enabled" },
        };
      }
      return {};
    }
    case "siliconflow": {
      // SiliconFlow: 仅 thinking_budget，无显式 on/off 开关
      if (reasoning.mode === "budget" && reasoning.budgetTokens !== undefined) {
        return { thinking_budget: reasoning.budgetTokens };
      }
      return {};
    }
    case "custom":
      return {};
  }
}

/** 把 ModelConfig.reasoning 翻译成 Gemini thinkingConfig，返回 undefined 表示不下发。 */
export function buildGeminiThinkingConfig(
  model: ModelConfig,
): GenerateContentConfig["thinkingConfig"] | undefined {
  const reasoning = model.reasoning;
  if (!reasoning || !reasoning.mode || reasoning.mode === "auto") {
    return undefined;
  }
  if (reasoning.mode === "off") {
    return { thinkingBudget: 0 };
  }
  if (reasoning.mode === "budget" && reasoning.budgetTokens !== undefined) {
    return { thinkingBudget: reasoning.budgetTokens };
  }
  // 'effort' 不适用于 Gemini，忽略
  return undefined;
}

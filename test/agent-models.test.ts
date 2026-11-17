import test from "node:test";
import assert from "node:assert/strict";
import { agentModelFor, checkAgentModels, type AgentModelConfig } from "../src/agent/models";
import type { ProviderConfig } from "../src/llm/provider";

const G = "qq:2860C352DF05A086C87D7CFD6FA5012E";
const deepseek: ProviderConfig = { id: "deepseek", name: "DeepSeek", type: "openai", apiKey: "k", images: { transport: "deepseek-files", maxPixels: 1300 * 1300 } };
const claude: ProviderConfig = { id: "claude", name: "Claude", type: "anthropic", apiKey: "k", images: { transport: "inline", maxPixels: 1_150_000, inlineBudgetMiB: 20 } };
const flash: AgentModelConfig = { providerId: "deepseek", modelName: "deepseek-flash", maxTokens: 4096, cacheTtlMinutes: 240, reasoning: { mode: "off" } };
const sonnet: AgentModelConfig = { providerId: "claude", modelName: "claude-sonnet-5-5", maxTokens: 4096, cacheTtlMinutes: 60, reasoning: { mode: "off" } };

test("listed groups use their own model, the rest use the default", () => {
  const modelFor = agentModelFor({ model: flash, groupModels: { [G]: sonnet } });
  assert.equal(modelFor(G), sonnet);
  assert.equal(modelFor("qq:OTHER"), flash);
});

test("every referenced provider is checked and problems name the group", () => {
  const uses = checkAgentModels({ model: flash, groupModels: { [G]: sonnet } }, [deepseek, claude]);
  assert.deepEqual(typeof uses === "string" ? uses : uses.map((u) => [u.label, u.provider.id]), [
    ["默认 agent 模型", "deepseek"],
    [`群 ${G} 的 agent 模型`, "claude"],
  ]);

  const check = (groupModel: AgentModelConfig, providers = [deepseek, claude]) => checkAgentModels({ model: flash, groupModels: { [G]: groupModel } }, providers);
  assert.match(check(sonnet, [deepseek]) as string, new RegExp(`群 ${G} 的 agent 模型的供应商 claude 不存在`));
  assert.match(check(sonnet, [deepseek, { ...claude, apiKey: "" }]) as string, /没有 API Key/);
  assert.match(check(sonnet, [deepseek, { ...claude, type: "gemini" }]) as string, /agent 只支持 OpenAI 兼容或 anthropic/);
  assert.match(check({ ...sonnet, maxTokens: undefined }) as string, /没有设置 maxTokens/);
  assert.match(check({ ...sonnet, temperature: 0.9 }) as string, new RegExp(`群 ${G} 的 agent 模型不合格：.*temperature`));
  assert.match(check({ ...sonnet, reasoning: { mode: "budget", budgetTokens: 1000 } }) as string, /不支持 budget/);
  assert.match(check({ ...flash, cacheTtlMinutes: 5 }) as string, /cacheTtlMinutes 是 5，要大于睡前整理的提前量/);
  assert.match(check({ ...sonnet, cacheTtlMinutes: 240 }) as string, /cacheTtlMinutes 只能是 60/);
});

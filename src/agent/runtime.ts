import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "koishi";
import type { ModelConfig } from "../llm/provider";
import { DATA_DIR } from "../paths";
import type { AgentLLM } from "./llm";
import type { AgentLog } from "./log-store";
import type { ToolRegistry } from "./tools";

type Logger = ReturnType<Context["logger"]>;

/** 人设 + 环境说明。两者都是固定文本，不放时间等会变的内容，保证前缀可缓存。 */
export function loadAgentSystemPrompt(personaFile: string): string {
  const persona = readFileSync(join(DATA_DIR, "persona", personaFile), "utf8").trim();
  const environment = readFileSync(join(DATA_DIR, "agent", "environment.md"), "utf8").trim();
  return `${persona}\n\n---\n\n${environment}`;
}

export interface AgentRuntimeOptions {
  model: ModelConfig;
  maxSteps: number;
  systemPrompt: string;
  isShadow: (groupId: string) => boolean;
}

/**
 * 一次唤醒：把新到的群聊追加进 log，然后让模型用工具做事，直到它不再调用工具或用完步数。
 *
 * 不中途取消请求：取消会在 log 里留下"有 tool_calls 没有结果"的条目，下一次请求会被拒绝。
 * 改为每一步开始前先追加新到的消息，被 @ 时最多晚一步看到。
 * 唤醒期间又被唤醒，合并成跑完之后再跑一次。
 */
export class AgentRuntime {
  private running = new Map<string, Promise<void>>();
  private wakeAgain = new Set<string>();

  constructor(
    private log: AgentLog,
    private llm: AgentLLM,
    private tools: ToolRegistry,
    private options: AgentRuntimeOptions,
    private logger: Logger,
  ) {}

  wake(groupId: string): Promise<void> {
    const current = this.running.get(groupId);
    if (current) {
      this.wakeAgain.add(groupId);
      return current;
    }
    const run = this.runUntilSettled(groupId).finally(() => this.running.delete(groupId));
    this.running.set(groupId, run);
    return run;
  }

  private async runUntilSettled(groupId: string): Promise<void> {
    do {
      this.wakeAgain.delete(groupId);
      await this.runOnce(groupId);
    } while (this.wakeAgain.has(groupId));
  }

  private async runOnce(groupId: string): Promise<void> {
    const first = await this.log.appendPendingBatch(groupId);
    if (!first) return;

    const tools = this.tools.definitions();
    const ctx = { groupId, shadow: this.options.isShadow(groupId) };
    let promptTokens = 0;
    let cachedTokens = 0;
    let toolCalls = 0;

    for (let step = 1; step <= this.options.maxSteps; step++) {
      if (step > 1) await this.log.appendPendingBatch(groupId);
      const entries = await this.log.entries(groupId);
      const messages = [
        { role: "system" as const, content: this.options.systemPrompt },
        ...(await this.log.toChatMessages(entries)),
      ];

      const result = await this.llm.step(messages, tools, this.options.model);
      promptTokens += result.usage.promptTokens;
      cachedTokens += result.usage.cachedTokens;

      await this.log.appendEntry(groupId, {
        role: "assistant",
        content: result.content ? [{ type: "text", text: result.content }] : [],
        toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
        reasoning: result.reasoning,
      });
      if (result.toolCalls.length === 0) break;

      for (const call of result.toolCalls) {
        toolCalls++;
        const output = await this.tools.call(call, ctx);
        await this.log.appendEntry(groupId, { role: "tool", content: [{ type: "text", text: output }], toolCallId: call.id });
      }
      if (step === this.options.maxSteps) {
        this.logger.info(`[${groupId}] agent 用完了 ${this.options.maxSteps} 步，本次唤醒结束`);
      }
    }

    this.logger.debug(`[${groupId}] agent 唤醒完成: 工具调用 ${toolCalls} 次, prompt ${promptTokens} tokens (缓存命中 ${cachedTokens})`);
  }
}

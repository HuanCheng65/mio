import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "koishi";
import type { ModelConfig } from "../llm/provider";
import { DATA_DIR } from "../paths";
import { parseGroupId } from "../runtime/groups";
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

export function loadSleepPrompt(): string {
  return readFileSync(join(DATA_DIR, "agent", "sleep.md"), "utf8").trim();
}

export interface SleepOptions {
  /** 睡前整理的说明，{time} 会换成当前时间 */
  prompt: string;
  maxSteps: number;
  /** log 达到这个大小，在这次唤醒结束后睡 */
  compactTokens: number;
  /** 群里安静这么久就睡 */
  idleMs: number;
  /** log 小于这个就不值得整理 */
  minTokens: number;
  /** 新一段开头带上的最近消息条数 */
  tailEvents: number;
}

export interface AgentRuntimeOptions {
  model: ModelConfig;
  maxSteps: number;
  systemPrompt: string;
  isShadow: (groupId: string) => boolean;
  sleep: SleepOptions;
  /** 开了新的一段 log 之后调用（例如重置记忆浮现的去重） */
  onSegmentStart: (groupId: string) => void;
}

const pad = (n: number) => String(n).padStart(2, "0");
function clockNow(): string {
  const d = new Date();
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

/**
 * 每个群一条工作队列：唤醒（看新消息、用工具做事）和睡眠（整理记忆、开新一段 log）串行执行。
 *
 * 不中途取消请求：取消会在 log 里留下"有 tool_calls 没有结果"的条目，下一次请求会被拒绝。
 * 改为每一步开始前先追加新到的消息，被 @ 时最多晚一步看到。
 * 运行中又被唤醒或要求睡眠，记下来，当前这轮跑完后再处理。
 */
export class AgentRuntime {
  private running = new Map<string, Promise<void>>();
  private wakeAgain = new Set<string>();
  private sleepRequested = new Set<string>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastRequestAt = new Map<string, number>();

  constructor(
    private log: AgentLog,
    private llm: AgentLLM,
    private tools: ToolRegistry,
    private options: AgentRuntimeOptions,
    private logger: Logger,
  ) {}

  wake(groupId: string): Promise<void> {
    this.wakeAgain.add(groupId);
    return this.drain(groupId);
  }

  requestSleep(groupId: string): Promise<void> {
    this.sleepRequested.add(groupId);
    return this.drain(groupId);
  }

  /** 群里有新动静时调用：重新开始"安静多久就睡"的计时 */
  noteActivity(groupId: string): void {
    clearTimeout(this.idleTimers.get(groupId));
    this.idleTimers.set(groupId, setTimeout(() => {
      this.idleTimers.delete(groupId);
      this.requestSleep(groupId).catch((err) => this.logger.error(`[${groupId}] 睡前整理失败:`, err));
    }, this.options.sleep.idleMs));
  }

  dispose(): void {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
  }

  private drain(groupId: string): Promise<void> {
    const current = this.running.get(groupId);
    if (current) return current;
    const run = (async () => {
      while (this.sleepRequested.has(groupId) || this.wakeAgain.has(groupId)) {
        if (this.sleepRequested.has(groupId)) {
          this.sleepRequested.delete(groupId);
          await this.sleepOnce(groupId);
        } else {
          this.wakeAgain.delete(groupId);
          await this.wakeOnce(groupId);
          if ((await this.log.tokenCount(groupId)) >= this.options.sleep.compactTokens) this.sleepRequested.add(groupId);
        }
      }
    })().finally(() => this.running.delete(groupId));
    this.running.set(groupId, run);
    return run;
  }

  private async wakeOnce(groupId: string): Promise<void> {
    const first = await this.log.appendPendingBatch(groupId);
    if (!first) return;
    await this.steps(groupId, { maxSteps: this.options.maxSteps, allowOutward: true, appendArrivals: true });
  }

  private async sleepOnce(groupId: string): Promise<void> {
    const tokens = await this.log.tokenCount(groupId);
    if (tokens < this.options.sleep.minTokens) {
      this.logger.debug(`[${groupId}] log 只有 ${tokens} tokens，不用整理`);
      return;
    }

    await this.log.appendPendingBatch(groupId);
    await this.log.appendEntry(groupId, {
      role: "user",
      content: [{ type: "text", text: this.options.sleep.prompt.replace("{time}", clockNow()) }],
    });
    const result = await this.steps(groupId, { maxSteps: this.options.sleep.maxSteps, allowOutward: false, appendArrivals: false });
    if (result.endedWithTools) throw new Error(`[${groupId}] 睡前整理用完 ${this.options.sleep.maxSteps} 步，还没写出群速写和交接`);

    const sections = /【群速写】([\s\S]*?)【交接】([\s\S]*)/.exec(result.text);
    if (!sections) throw new Error(`[${groupId}] 睡前整理没有按【群速写】【交接】格式收尾:\n${result.text}`);
    const preamble = `〔群速写〕\n${sections[1].trim()}\n\n〔上一段的交接〕\n${sections[2].trim()}`;

    await this.log.startSegment(groupId, preamble, this.options.sleep.tailEvents);
    this.options.onSegmentStart(groupId);
    this.logger.info(`[${groupId}] 睡前整理完成，${tokens} tokens 的 log 收成新的一段`);
  }

  private async steps(
    groupId: string,
    options: { maxSteps: number; allowOutward: boolean; appendArrivals: boolean },
  ): Promise<{ text: string; endedWithTools: boolean }> {
    const { platform } = parseGroupId(groupId);
    const tools = this.tools.definitions(platform);
    const ctx = { groupId, platform, shadow: this.options.isShadow(groupId), allowOutward: options.allowOutward };
    let promptTokens = 0;
    let cachedTokens = 0;
    let toolCalls = 0;

    for (let step = 1; step <= options.maxSteps; step++) {
      if (step > 1 && options.appendArrivals) await this.log.appendPendingBatch(groupId);
      const entries = await this.log.entries(groupId);
      const messages = [
        { role: "system" as const, content: this.options.systemPrompt },
        ...(await this.log.toChatMessages(entries)),
      ];

      const sentAt = Date.now();
      const gap = sentAt - (this.lastRequestAt.get(groupId) ?? sentAt);
      const result = await this.llm.step(messages, tools, this.options.model);
      this.lastRequestAt.set(groupId, sentAt);
      promptTokens += result.usage.promptTokens;
      cachedTokens += result.usage.cachedTokens;
      // 实测 DeepSeek 的缓存能留多久：长间隔后的命中情况
      if (gap >= 30 * 60_000) {
        this.logger.info(`[${groupId}] 距上次请求 ${duration(gap)}，缓存命中 ${result.usage.cachedTokens}/${result.usage.promptTokens}`);
      }

      await this.log.appendEntry(groupId, {
        role: "assistant",
        content: result.content ? [{ type: "text", text: result.content }] : [],
        toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
        reasoning: result.reasoning,
      });
      if (result.toolCalls.length === 0) {
        this.logger.debug(`[${groupId}] agent 完成: 工具调用 ${toolCalls} 次, prompt ${promptTokens} tokens (缓存命中 ${cachedTokens})`);
        return { text: result.content, endedWithTools: false };
      }

      for (const call of result.toolCalls) {
        toolCalls++;
        const output = await this.tools.call(call, ctx);
        await this.log.appendEntry(groupId, { role: "tool", content: [{ type: "text", text: output }], toolCallId: call.id });
      }
    }
    this.logger.info(`[${groupId}] agent 用完了 ${options.maxSteps} 步`);
    return { text: "", endedWithTools: true };
  }
}

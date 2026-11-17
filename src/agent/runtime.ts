import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "koishi";
import { DATA_DIR } from "../paths";
import { parseGroupId } from "../runtime/groups";
import type { AgentLLM } from "./llm";
import type { AgentLog, ChatMessage } from "./log-store";
import { SLEEP_MARGIN_MINUTES, type AgentModelConfig } from "./models";
import type { ToolRegistry } from "./tools";

type Logger = ReturnType<Context["logger"]>;

/** 人设 + 环境说明。两者都是固定文本，不放时间等会变的内容，保证前缀可缓存。 */
export function loadAgentSystemPrompt(personaFile: string): string {
  const persona = readFileSync(join(DATA_DIR, "persona", personaFile), "utf8").trim();
  const environment = readFileSync(join(DATA_DIR, "agent", "environment.md"), "utf8").trim();
  return `${persona}\n\n---\n\n${environment}`;
}

export function loadReminder(): string {
  return readFileSync(join(DATA_DIR, "agent", "reminder.md"), "utf8").trim();
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
  /** log 小于这个就不值得整理 */
  minTokens: number;
  /** 新一段开头带上的最近消息条数 */
  tailEvents: number;
}

export interface AgentRuntimeOptions {
  /** 这个群用的 agent 模型（按群覆盖，没覆盖的用默认）；唤醒和睡前整理的每一步都按它选 */
  modelFor: (groupId: string) => AgentModelConfig;
  maxSteps: number;
  systemPrompt: string;
  /**
   * 唤醒时每一步请求末尾的说话提醒。人设在 log 最前面，log 一长就被她自己最近的话盖过去。
   * 提醒只管那一轮；请求成功后连同回复一起写进 log，以后原样发回、留在原位，前缀不变。
   */
  reminder: string;
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
  /** 手动要求的整理：不管 log 有多小都整理 */
  private forcedSleep = new Set<string>();
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

  requestSleep(groupId: string, force = false): Promise<void> {
    this.sleepRequested.add(groupId);
    if (force) this.forcedSleep.add(groupId);
    return this.drain(groupId);
  }

  /**
   * 缓存从最后一次请求开始计时：唤醒的请求发出后，安排在这个群的模型缓存过期前 SLEEP_MARGIN_MINUTES 分钟睡前整理。
   * 整理读到的还是缓存，之后从小的一段重新开始；不然下次唤醒要把整段按写入价重写一遍。
   * 计时期间又发了请求就重新计时；到点时如果有更新的请求（可能还在进行），这次不算。
   */
  private scheduleSleep(groupId: string, sentAt: number): void {
    clearTimeout(this.idleTimers.get(groupId));
    const ttlMs = this.options.modelFor(groupId).cacheTtlMinutes * 60_000;
    const delay = sentAt + ttlMs - SLEEP_MARGIN_MINUTES * 60_000 - Date.now();
    this.idleTimers.set(groupId, setTimeout(() => {
      this.idleTimers.delete(groupId);
      if (this.lastRequestAt.get(groupId) !== sentAt) return;
      this.requestSleep(groupId).catch((err) => this.logger.error(`[${groupId}] 睡前整理失败:`, err));
    }, Math.max(0, delay)).unref());
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
          await this.sleepOnce(groupId, this.forcedSleep.delete(groupId));
        } else {
          this.wakeAgain.delete(groupId);
          await this.wakeOnce(groupId);
          if ((await this.log.tokenCount(groupId)) >= this.options.sleep.compactTokens || (await this.log.overImageBudget(groupId))) {
            this.sleepRequested.add(groupId);
          }
        }
      }
    })().finally(() => this.running.delete(groupId));
    this.running.set(groupId, run);
    return run;
  }

  private async wakeOnce(groupId: string): Promise<void> {
    await this.closeInterrupted(groupId);
    const first = await this.log.appendPendingBatch(groupId);
    if (!first) return;
    await this.steps(groupId, { maxSteps: this.options.maxSteps, allowOutward: true, appendArrivals: true });
  }

  private async closeInterrupted(groupId: string): Promise<void> {
    const closed = await this.log.closeInterruptedCalls(groupId);
    if (closed > 0) this.logger.warn(`[${groupId}] 上次有 ${closed} 个工具调用执行到一半进程就退出了，已在 log 里标成中断`);
  }

  private async sleepOnce(groupId: string, force: boolean): Promise<void> {
    await this.closeInterrupted(groupId);
    const tokens = await this.log.tokenCount(groupId);
    if (!force && tokens < this.options.sleep.minTokens) {
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
    const released = await this.log.releaseUnusedImages();
    if (released > 0) this.logger.info(`[${groupId}] 释放了 ${released} 张不再引用的图`);
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
    let cacheWriteTokens = 0;
    let toolCalls = 0;

    for (let step = 1; step <= options.maxSteps; step++) {
      if (step > 1 && options.appendArrivals) await this.log.appendPendingBatch(groupId);
      const entries = await this.log.entries(groupId);
      const messages: ({ role: "system"; content: string } | ChatMessage)[] = [
        { role: "system" as const, content: this.options.systemPrompt },
        ...(await this.log.toChatMessages(entries)),
      ];
      // 唤醒的每一步末尾都带一份提醒：工具结果也算新一轮，之前那份已经清掉了
      if (options.appendArrivals) messages.push({ role: "reminder", content: this.options.reminder });
      const sentAt = Date.now();
      const gap = sentAt - (this.lastRequestAt.get(groupId) ?? sentAt);
      this.lastRequestAt.set(groupId, sentAt);
      const result = await this.llm.step(messages, tools, this.options.modelFor(groupId));
      if (options.appendArrivals) this.scheduleSleep(groupId, sentAt);
      promptTokens += result.usage.promptTokens;
      cachedTokens += result.usage.cachedTokens;
      cacheWriteTokens += result.usage.cacheWriteTokens;
      // 实测缓存能留多久：长间隔后的命中情况（缓存写入只有 Anthropic 单独报告，写入多说明没命中）
      if (gap >= 30 * 60_000) {
        this.logger.info(`[${groupId}] 距上次请求 ${duration(gap)}，缓存命中 ${result.usage.cachedTokens}/${result.usage.promptTokens}，缓存写入 ${result.usage.cacheWriteTokens}`);
      }

      // 提醒和回复一起写进 log：请求失败就都不写，log 里不会留下后面没有 assistant 回合的提醒（Anthropic 会拒绝）。
      // 什么都没回的一步在 Anthropic 请求里会被省略，这时也不写提醒，否则它后面会紧跟下一条 user 消息
      const rendered = result.anthropicContent ? result.anthropicContent.length > 0 : Boolean(result.content) || result.toolCalls.length > 0;
      if (options.appendArrivals && rendered) {
        await this.log.appendEntry(groupId, { role: "reminder", content: [{ type: "text", text: this.options.reminder }] });
      }
      await this.log.appendEntry(groupId, {
        role: "assistant",
        content: result.content ? [{ type: "text", text: result.content }] : [],
        toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
        reasoning: result.reasoning,
        anthropicContent: result.anthropicContent,
        promptDigest: result.promptDigest,
      });
      if (result.toolCalls.length === 0) {
        this.logger.debug(`[${groupId}] agent 完成: 工具调用 ${toolCalls} 次, prompt ${promptTokens} tokens (缓存命中 ${cachedTokens}，缓存写入 ${cacheWriteTokens})`);
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

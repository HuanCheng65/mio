import type { Context } from "koishi";
import { parseGroupId } from "../runtime/groups";
import type { AgentLLM } from "./llm";
import type { AgentLog, ChatMessage, PromptSnapshot } from "./log-store";
import type { AgentPrompts } from "./prompts";
import { SLEEP_MARGIN_MINUTES, type AgentModelConfig } from "./models";
import { sameTools, type ToolRegistry } from "./tools";

type Logger = ReturnType<Context["logger"]>;

export interface SleepOptions {
  maxSteps: number;
  /** 唤醒的最后一次请求的真实上下文（API 返回的输入 + 输出 token）达到这个大小，这次唤醒结束后就睡 */
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
  /**
   * 当前的提示词（Console 里改了之后：提醒和睡前整理下一步就用新的；人设和环境说明要等压缩后的新一段）。
   * reminder 是唤醒时每一步请求末尾的说话提醒：人设在 log 最前面，log 一长就被她自己最近的话盖过去。
   * 提醒只管那一轮；请求成功后连同回复一起写进 log，以后原样发回、留在原位，前缀不变。
   */
  prompts: () => AgentPrompts;
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
          // 人设或环境说明改了：Anthropic 上没法在对话中途替换开头的 system（追加的话旧的还在），
          // 先用旧的整理完（还能读缓存），新的一段用新的开头。其他供应商也一样处理，省得一段里人设前后不一。
          // 叫醒她的新消息不在整理时看，留给紧接着的这次唤醒，她才会回应
          if (await this.systemChanged(groupId)) {
            this.logger.info(`[${groupId}] 人设或环境说明改了，先睡前整理，新的一段用新的`);
            await this.sleepOnce(groupId, true, false);
          }
          const contextTokens = await this.wakeOnce(groupId);
          if ((contextTokens !== null && contextTokens >= this.options.sleep.compactTokens) || (await this.log.overImageBudget(groupId))) {
            this.sleepRequested.add(groupId);
          }
        }
      }
    })().finally(() => this.running.delete(groupId));
    this.running.set(groupId, run);
    return run;
  }

  private async systemChanged(groupId: string): Promise<boolean> {
    const base = (await this.log.entries(groupId)).find((e) => e.role === "prompt");
    return base !== undefined && base.prompt!.system !== this.options.prompts().systemPrompt;
  }

  /** 返回最后一次请求的真实上下文大小；没有新消息、没发请求时返回 null */
  private async wakeOnce(groupId: string): Promise<number | null> {
    await this.closeInterrupted(groupId);
    const first = await this.log.appendPendingBatch(groupId);
    if (!first) return null;
    return (await this.steps(groupId, { maxSteps: this.options.maxSteps, allowOutward: true, appendArrivals: true })).contextTokens;
  }

  private async closeInterrupted(groupId: string): Promise<void> {
    const closed = await this.log.closeInterruptedCalls(groupId);
    if (closed > 0) this.logger.warn(`[${groupId}] 上次有 ${closed} 个工具调用执行到一半进程就退出了，已在 log 里标成中断`);
  }

  private async sleepOnce(groupId: string, force: boolean, takeArrivals = true): Promise<void> {
    await this.closeInterrupted(groupId);
    const tokens = await this.log.tokenCount(groupId);
    if (!force && tokens < this.options.sleep.minTokens) {
      this.logger.debug(`[${groupId}] log 只有 ${tokens} tokens，不用整理`);
      return;
    }

    if (takeArrivals) await this.log.appendPendingBatch(groupId);
    await this.log.appendEntry(groupId, {
      role: "user",
      content: [{ type: "text", text: this.options.prompts().sleep.replace("{time}", clockNow()) }],
    });
    const result = await this.steps(groupId, { maxSteps: this.options.sleep.maxSteps, allowOutward: false, appendArrivals: false });
    if (result.endedWithTools) throw new Error(`[${groupId}] 睡前整理用完 ${this.options.sleep.maxSteps} 步，还没写出群速写和交接`);

    // 用 XML 标签而不是【群速写】【交接】：Claude 会把【群速写】写成【群群速写】【群变速写】，整理就失败了
    const sections = /<sketch>([\s\S]*?)<\/sketch>[\s\S]*?<handoff>([\s\S]*?)<\/handoff>/.exec(result.text);
    if (!sections) throw new Error(`[${groupId}] 睡前整理没有按 <sketch> <handoff> 格式收尾:\n${result.text}`);
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
  ): Promise<{ text: string; endedWithTools: boolean; contextTokens: number }> {
    const { platform } = parseGroupId(groupId);
    const tools = this.tools.definitions(platform);
    const ctx = { groupId, platform, shadow: this.options.isShadow(groupId), allowOutward: options.allowOutward };
    let promptTokens = 0;
    let cachedTokens = 0;
    let cacheWriteTokens = 0;
    let toolCalls = 0;
    // 最后一次请求的输入 + 输出：请求刚结束时，这就是当前上下文的真实大小
    let contextTokens = 0;

    for (let step = 1; step <= options.maxSteps; step++) {
      if (step > 1 && options.appendArrivals) await this.log.appendPendingBatch(groupId);
      // 每一步取一次：发出去的提醒和写进 log 的必须是同一份
      const prompts = this.options.prompts();
      let entries = await this.log.entries(groupId);
      if (!entries.some((e) => e.role === "prompt")) {
        // 这一段的第一步：记下开头的提示词快照。它只决定顶层 system / tools，不出现在对话里，可以先写
        await this.log.appendEntry(groupId, { role: "prompt", content: [], prompt: { system: prompts.systemPrompt, tools } });
        entries = await this.log.entries(groupId);
      }
      const snapshots = entries.filter((e) => e.role === "prompt").map((e) => e.prompt!);
      // 工具定义改了：这一步末尾带上变更（Anthropic 上是对话中途的工具替换）。变更是不清掉的 system 消息，
      // 后面不能再接一条提醒，所以这一步不带提醒
      const change: PromptSnapshot | null = sameTools(snapshots[snapshots.length - 1].tools, tools) ? null : { system: snapshots[0].system, tools };
      const messages: ({ role: "system"; content: string } | ChatMessage)[] = [
        { role: "system" as const, content: prompts.systemPrompt },
        ...(await this.log.toChatMessages(entries)),
      ];
      if (change) messages.push({ role: "prompt", ...change });
      // 唤醒的每一步末尾都带一份提醒：工具结果也算新一轮，之前那份已经清掉了
      else if (options.appendArrivals) messages.push({ role: "reminder", content: prompts.reminder });
      const sentAt = Date.now();
      const gap = sentAt - (this.lastRequestAt.get(groupId) ?? sentAt);
      this.lastRequestAt.set(groupId, sentAt);
      const result = await this.llm.step(messages, tools, this.options.modelFor(groupId));
      if (options.appendArrivals) this.scheduleSleep(groupId, sentAt);
      promptTokens += result.usage.promptTokens;
      cachedTokens += result.usage.cachedTokens;
      cacheWriteTokens += result.usage.cacheWriteTokens;
      contextTokens = result.usage.promptTokens + result.usage.completionTokens;
      // 实测缓存能留多久：长间隔后的命中情况（缓存写入只有 Anthropic 单独报告，写入多说明没命中）
      if (gap >= 30 * 60_000) {
        this.logger.info(`[${groupId}] 距上次请求 ${duration(gap)}，缓存命中 ${result.usage.cachedTokens}/${result.usage.promptTokens}，缓存写入 ${result.usage.cacheWriteTokens}`);
      }

      // 提醒（或工具变更）和回复一起写进 log：请求失败就都不写，log 里不会留下后面没有 assistant 回合的
      // system 消息（Anthropic 会拒绝）。什么都没回的一步在 Anthropic 请求里会被省略，这时也不写，
      // 否则它后面会紧跟下一条 user 消息；工具变更就留到下一步再带
      const rendered = result.anthropicContent ? result.anthropicContent.length > 0 : Boolean(result.content) || result.toolCalls.length > 0;
      if (rendered && change) {
        await this.log.appendEntry(groupId, { role: "prompt", content: [], prompt: change });
      } else if (rendered && options.appendArrivals) {
        await this.log.appendEntry(groupId, { role: "reminder", content: [{ type: "text", text: prompts.reminder }] });
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
        return { text: result.content, endedWithTools: false, contextTokens };
      }

      for (const call of result.toolCalls) {
        toolCalls++;
        const output = await this.tools.call(call, ctx);
        await this.log.appendEntry(groupId, { role: "tool", content: [{ type: "text", text: output }], toolCallId: call.id });
      }
    }
    this.logger.info(`[${groupId}] agent 用完了 ${options.maxSteps} 步`);
    return { text: "", endedWithTools: true, contextTokens };
  }
}

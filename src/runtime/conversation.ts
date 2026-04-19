import * as fs from "fs";
import * as path from "path";
import { Session, h } from "koishi";
import type { OneBotBot } from "@wittf/koishi-plugin-adapter-onebot";
import { humanizedSend, resolveAtMentions, UserInfo } from "../delivery/humanize";
import { getPromptManager } from "../memory/prompt-manager";
import type { Action, LLMResponse, SearchRequest } from "../types/response";
import { SILENCE_THRESHOLD } from "../types/response";
import type { ImageSegment, NormalizedMessage } from "../perception/types";
import {
  ALLOWED_REACT_EMOJI_NAMES,
  countTrailingBotMessages,
  findEmoji,
  isMentioningBot,
  stickerMimeType,
  validateResponse,
} from "../helpers";
import { RuntimeDeps, RuntimeState } from "./types";

export function createConversationRuntime(deps: RuntimeDeps, state: RuntimeState) {
  const {
    buffer,
    config,
    debouncer,
    extractionScheduler,
    llm,
    logger,
    memory,
    promptBuilder,
    renderer,
    searchService,
    shadowLogger,
    stickerService,
  } = deps;

  async function triggerMemoryExtraction(groupId: string, reason: string): Promise<void> {
    if (!memory || !extractionScheduler) return;
    if (state.extractionLocks.get(groupId)) {
      logger.debug(`[${groupId}] 记忆提取已在进行中，跳过`);
      return;
    }

    const pendingCount = extractionScheduler.getPendingCount(groupId);
    if (pendingCount === 0) {
      logger.debug(`[${groupId}] 没有新消息需要提取`);
      return;
    }

    const cutoff = extractionScheduler.getLastExtractedAt(groupId);
    const messages = buffer.getRecent(groupId).filter((m) => m.timestamp > cutoff);
    if (messages.length === 0) {
      logger.debug(`[${groupId}] buffer 中没有新消息（可能已被清理），重置计数器`);
      extractionScheduler.markExtracted(groupId);
      return;
    }

    logger.debug(`[${groupId}] 触发记忆提取 (${reason}, ${messages.length} 条消息, pending=${pendingCount})`);
    state.extractionLocks.set(groupId, true);
    try {
      const summary = await memory.record({
        groupId,
        recentMessages: messages,
        botName: config.botName,
      });

      const lastProcessedTimestamp = messages[messages.length - 1].timestamp;
      extractionScheduler.markExtracted(groupId, lastProcessedTimestamp);

      if (summary.worthRemembering || summary.culturalObservations > 0) {
        const parts = [
          `记忆提取完成: ${summary.episodes} 条记忆, ${summary.relational} 条关系, ${summary.vibes} 条情绪, ${summary.culturalObservations} 条文化观察`,
          ...summary.episodeSummaries.map((s) => `  ep: ${s}`),
          ...summary.relationalSummaries.map((s) => `  rel: ${s}`),
          ...summary.sessionVibes.map((s) => `  vibe: ${s}`),
          ...summary.culturalSummaries.map((s) => `  culture: ${s}`),
        ];
        logger.debug(`[${groupId}] ${parts.join("\n")}`);
      } else {
        logger.debug(`[${groupId}] 记忆提取完成: 无值得记住的内容`);
      }
    } catch (err) {
      logger.warn(`[${groupId}] 记忆提取失败:`, err);
    } finally {
      state.extractionLocks.delete(groupId);
    }
  }

  function getNewMessages(groupId: string): NormalizedMessage[] {
    const cutoff = state.lastRespondedAt.get(groupId) || 0;
    return buffer.getRecent(groupId).filter((m) => !m.isBot && m.timestamp > cutoff);
  }

  async function waitForPendingImages(groupId: string, signal: AbortSignal): Promise<void> {
    const imageTasks = state.pendingImageTasks.get(groupId) || [];
    if (imageTasks.length === 0) return;
    logger.debug(`[${groupId}] 等待 ${imageTasks.length} 个图片处理任务完成...`);

    const IMAGE_TIMEOUT = 12000;
    const results = await Promise.all(
      imageTasks.map(async (task) => {
        if (signal.aborted) return null;
        try {
          const result = await Promise.race([
            task.promise,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), IMAGE_TIMEOUT)),
          ]);
          const elapsed = Date.now() - task.startTime;
          if (result === null && elapsed >= IMAGE_TIMEOUT) {
            logger.warn(`[${groupId}] 图片处理超时 (${elapsed}ms)`);
            return { messageId: task.messageId, description: "[图片：没看清]" };
          }
          return { messageId: task.messageId, description: result || "[图片]" };
        } catch (error) {
          logger.error(`[${groupId}] 图片处理异常:`, error);
          return { messageId: task.messageId, description: "[图片：没看清]" };
        }
      }),
    );

    if (signal.aborted) return;

    const allMessages = buffer.getRecent(groupId);
    for (const result of results) {
      if (!result) continue;
      const msg = allMessages.find((m) => m.id === result.messageId);
      if (msg && result.description) {
        const imgSeg = msg.segments.find((s): s is ImageSegment => s.type === "image" && !s.description);
        if (imgSeg) {
          imgSeg.description = result.description;
        }
        logger.debug(`[${groupId}] 更新消息 ${result.messageId} 图片描述: ${result.description}`);
      }
    }

    state.pendingImageTasks.delete(groupId);
  }

  function buildUsersSnapshot(groupId: string): UserInfo[] {
    const users: UserInfo[] = [];
    const seenIds = new Set<string>();
    for (const m of buffer.getRecent(groupId)) {
      if (!m.isBot && !seenIds.has(m.senderId)) {
        seenIds.add(m.senderId);
        users.push({ name: m.sender, id: m.senderId });
      }
    }
    return users;
  }

  function pushBotMessage(
    groupId: string,
    selfId: string,
    content: string,
    segmentType: "text" | "notice" = "text",
  ): void {
    buffer.push(groupId, {
      id: crypto.randomUUID(),
      sender: config.botName,
      senderId: selfId,
      isBot: true,
      timestamp: Date.now(),
      segments: [{ type: segmentType, content }],
      mentions: [],
      ...(segmentType === "text" ? { rawContent: content } : {}),
    });
  }

  async function executeActions(
    actions: Action[],
    msgMap: Map<string, NormalizedMessage>,
    groupId: string,
    session: Session,
    signal: AbortSignal,
  ): Promise<boolean> {
    const usersSnapshot = buildUsersSnapshot(groupId);
    let hasSentMessage = false;

    for (const action of actions) {
      if (signal.aborted) break;

      if (action.type === "message") {
        if (!action.content.trim()) continue;
        const processed = resolveAtMentions(action.content, usersSnapshot).replace(/@#(\d+)/g, '<at id="$1"/>');
        await humanizedSend(session, processed);
        pushBotMessage(groupId, session.selfId, action.content);
        hasSentMessage = true;
      } else if (action.type === "reply") {
        const realMsg = msgMap.get(action.target_msg_id);
        if (!realMsg) {
          logger.warn(`[${groupId}] reply 目标消息不存在: ${action.target_msg_id}`);
          continue;
        }
        if (!action.text?.trim()) continue;

        const processed = resolveAtMentions(action.text, usersSnapshot).replace(/@#(\d+)/g, '<at id="$1"/>');
        await humanizedSend(session, `<quote id="${realMsg.id}"/>${processed}`);
        pushBotMessage(groupId, session.selfId, action.text);
        hasSentMessage = true;
      } else if (action.type === "react") {
        const realMsg = msgMap.get(action.target_msg_id);
        if (!realMsg) {
          logger.warn(`[${groupId}] react 目标消息不存在: ${action.target_msg_id}`);
          continue;
        }
        if (realMsg.isSystemEvent) {
          logger.debug(`[${groupId}] 跳过对系统消息的 react: ${action.target_msg_id}`);
          continue;
        }

        const emoji = findEmoji(action.emoji_name, {
          allowedNames: ALLOWED_REACT_EMOJI_NAMES,
          maxDistance: 0,
        });
        if (!emoji) {
          logger.warn(
            `[${groupId}] react 表情不在允许列表或无法匹配: ${action.emoji_name} (allowed=${ALLOWED_REACT_EMOJI_NAMES.join("、")})`,
          );
          continue;
        }

        try {
          const bot = session.bot as OneBotBot<any>;
          await bot.internal.setMsgEmojiLike(realMsg.id, emoji.id);
          buffer.handleReaction(realMsg.id, emoji.name, session.selfId, true, session.selfId);
          logger.debug(`[${groupId}] 对消息 ${action.target_msg_id} 发送表情: ${emoji.name}`);
        } catch (err) {
          logger.warn(`[${groupId}] 发送表情失败:`, err);
        }
      } else if (action.type === "sticker") {
        if (!stickerService) {
          logger.debug("[sticker] 表情包服务未启用，跳过");
          continue;
        }
        try {
          const sticker = await stickerService.resolveSticker(action.intent);
          if (!sticker) {
            logger.debug(`[sticker] 没找到匹配的表情包 (intent: ${action.intent})`);
            continue;
          }
          const imgBuf = fs.readFileSync(sticker.imagePath);
          if (imgBuf.length > 2 * 1024 * 1024) {
            logger.warn(
              `[sticker] 文件过大 (${(imgBuf.length / 1024 / 1024).toFixed(1)} MB)，跳过发送: ${path.basename(sticker.imagePath)}`,
            );
            continue;
          }
          await session.send(h.image(imgBuf, stickerMimeType(sticker.imagePath)));
          hasSentMessage = true;
          logger.debug(`[sticker] 发送表情包: ${path.basename(sticker.imagePath)}`);
          pushBotMessage(
            groupId,
            session.selfId,
            `（发了张表情包——本来想找「${action.intent}」，找到了「${sticker.description}」）`,
            "notice",
          );
        } catch (err) {
          logger.warn("[sticker] 发送表情包失败:", err);
        }
      } else if (action.type === "recall") {
        const realMsg = msgMap.get(action.target_msg_id);
        if (!realMsg) {
          logger.warn(`[${groupId}] recall 目标消息不存在: ${action.target_msg_id}`);
          continue;
        }
        if (!realMsg.isBot) {
          logger.warn(`[${groupId}] recall 目标消息不是 bot 消息: ${action.target_msg_id}`);
          continue;
        }
        try {
          await session.bot.deleteMessage(session.channelId, realMsg.id);
          buffer.markRecalled(realMsg.id);
          logger.debug(`[${groupId}] 撤回消息: ${action.target_msg_id}`);
        } catch (err) {
          logger.warn(`[${groupId}] 撤回失败:`, err);
        }
      } else {
        logger.warn(`未知的 action 类型: ${(action as any).type}`);
      }
    }

    return hasSentMessage;
  }

  async function handleSearch(
    searchRequest: SearchRequest,
    originalNewMessages: NormalizedMessage[],
    msgMap: Map<string, NormalizedMessage>,
    groupId: string,
    session: Session,
    signal: AbortSignal,
  ): Promise<void> {
    if (!searchService) {
      logger.warn("搜索服务未启用，跳过搜索");
      return;
    }

    try {
      logger.debug(`[${groupId}] 执行搜索: ${searchRequest.query} (hint: ${searchRequest.hint})`);
      const resolveImageUrl = (shortMsgId: string, imageIndex: number = 0): string | null => {
        const targetMsg = msgMap.get(shortMsgId);
        if (!targetMsg) {
          logger.warn(`[${groupId}] resolveImageUrl: 短 ID ${shortMsgId} 在 msgMap 中找不到`);
          return null;
        }
        const imageSegs = targetMsg.segments.filter((s): s is ImageSegment => s.type === "image");
        if (imageSegs.length === 0) return null;
        const safeIndex = imageIndex >= 0 && imageIndex < imageSegs.length ? imageIndex : 0;
        return imageSegs[safeIndex]?.url ?? null;
      };
      const searchInjection = await searchService.search(searchRequest, resolveImageUrl);
      logger.debug(`[${groupId}] 搜索结果: ${searchInjection}`);

      const newMessagesText = originalNewMessages.map((m) => renderer.renderMessage(m)).join("\n");
      const fiveMinAgoSearch = Date.now() - 5 * 60_000;
      const recentBotCountSearch = buffer
        .getRecent(groupId)
        .filter((m) => m.isBot && m.timestamp > fiveMinAgoSearch).length;
      const recentBotActivitySearch =
        recentBotCountSearch > 0 ? `（你最近 5 分钟内说了 ${recentBotCountSearch} 条消息。）\n` : "";

      const promptManager = getPromptManager();
      const followupPrompt = promptManager.get("search_followup_prompt", {
        newMessages: newMessagesText,
        searchInjection,
        recentBotActivity: recentBotActivitySearch,
      });

      const allMessagesForSearch = buffer.getRecent(groupId);
      const newMessageIdsForSearch = new Set(originalNewMessages.map((m) => m.id));
      const { text: recentMessagesFormatted, msgMap: searchMsgMap } = renderer.render(
        allMessagesForSearch,
        newMessageIdsForSearch,
      );

      let memoryUserProfile = "";
      let memoryMemories = "";
      let memoryGroupCulture = "";
      if (memory) {
        try {
          const participantIds = [...new Set(originalNewMessages.map((m) => m.senderId))];
          const allBuffered = buffer.getRecent(groupId);
          const memCtx = await memory.getMemoryContext(groupId, participantIds, originalNewMessages, allBuffered);
          if (memCtx.userProfile) memoryUserProfile = memCtx.userProfile;
          if (memCtx.memories) memoryMemories = memCtx.memories;
          if (memCtx.groupCulture) memoryGroupCulture = memCtx.groupCulture;
        } catch (err) {
          logger.warn("获取记忆上下文失败:", err);
        }
      }

      const currentStickerSummary = stickerService?.getSummary() || undefined;
      const systemPrompt = promptBuilder.buildSystemPrompt({
        recentMessages: recentMessagesFormatted,
        userProfile: memoryUserProfile,
        groupCulture: memoryGroupCulture,
        memories: memoryMemories,
        stickerSummary: currentStickerSummary,
      });

      if (memoryUserProfile || memoryMemories || memoryGroupCulture || currentStickerSummary) {
        logger.debug(
          `[${groupId}] === 搜索回合记忆注入摘要 ===` +
            (memoryUserProfile ? `\n[userProfile]\n${memoryUserProfile}` : "") +
            (memoryMemories ? `\n[memories]\n${memoryMemories}` : "") +
            (memoryGroupCulture ? `\n[groupCulture]\n${memoryGroupCulture}` : "") +
            (currentStickerSummary ? `\n[stickerSummary]\n${currentStickerSummary}` : ""),
        );
      }

      logger.debug(`[${groupId}] 搜索后调用 LLM...`);
      const response = await llm.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: followupPrompt },
        ],
        config.models.chat,
        { signal, purpose: "conversation-search" },
      );

      logger.info(
        `[${groupId}] 搜索后 LLM 响应: ${response.content} (tokens: ${response.usage.promptTokens}+${response.usage.completionTokens})`,
      );

      let parsedResponse: LLMResponse;
      try {
        const jsonMatch = response.content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          logger.warn("搜索后 LLM 输出不包含 JSON，跳过");
          return;
        }
        parsedResponse = JSON.parse(jsonMatch[0]);
        parsedResponse.silent = (parsedResponse.urge ?? 10) < SILENCE_THRESHOLD;
      } catch (error) {
        logger.error("解析搜索后 LLM JSON 输出失败:", error);
        return;
      }

      if (parsedResponse.search) {
        logger.warn("搜索后 LLM 仍返回 search 请求，视为 silent");
        return;
      }
      if (signal.aborted) {
        logger.debug(`[${groupId}] 搜索后请求已被取消，跳过 action 执行`);
        return;
      }

      if (shadowLogger && config.shadowGroups.includes(groupId)) {
        const messageSummary = originalNewMessages.map((m) => ({
          sender: m.sender,
          content: m.segments.map((s) => ("content" in s ? s.content : null) || `[${s.type}]`).join(""),
        }));
        shadowLogger.log({
          groupId,
          phase: "search",
          newMessages: messageSummary,
          thought: parsedResponse.thought,
          urge: parsedResponse.urge ?? -1,
          silent: parsedResponse.silent,
          actions: parsedResponse.actions || null,
          search: null,
        });
        logger.debug(`[${groupId}] [shadow] 已记录搜索后 LLM 响应`);
        if (originalNewMessages.length > 0) {
          state.lastRespondedAt.set(groupId, originalNewMessages[originalNewMessages.length - 1].timestamp);
        }
        return;
      }

      if (!parsedResponse.silent && parsedResponse.actions && parsedResponse.actions.length > 0) {
        const hasSent = await executeActions(parsedResponse.actions, searchMsgMap, groupId, session, signal);
        if (hasSent) {
          debouncer.markSpoke(groupId);
          const hourCount = state.hourlyReplies.get(groupId) || 0;
          state.hourlyReplies.set(groupId, hourCount + 1);
        }
      }

      if (originalNewMessages.length > 0) {
        state.lastRespondedAt.set(groupId, originalNewMessages[originalNewMessages.length - 1].timestamp);
      }
    } catch (error) {
      logger.error(`[${groupId}] 搜索处理失败:`, error);
    }
  }

  async function processConversation(groupId: string, session: Session, isMentioned: boolean = false) {
    if (isMentioned) {
      const existing = state.activeRequests.get(groupId);
      if (existing) {
        existing.abort();
        logger.debug(`[${groupId}] 被 @ 触发，取消旧请求`);
      }
    } else if (state.activeRequests.has(groupId)) {
      logger.debug(`[${groupId}] 已有请求在处理，跳过本次触发`);
      return;
    }

    const controller = new AbortController();
    state.activeRequests.set(groupId, controller);
    let newMessages: NormalizedMessage[] = [];

    try {
      const hourCount = state.hourlyReplies.get(groupId) || 0;
      if (hourCount >= config.safety.maxReplyPerHour) {
        logger.debug(`[${groupId}] 达到每小时回复上限`);
        return;
      }

      const recent = buffer.getRecent(groupId, config.safety.maxConsecutiveReplies + 1);
      const consecutiveBotReplies = countTrailingBotMessages(recent);
      if (consecutiveBotReplies >= config.safety.maxConsecutiveReplies) {
        logger.debug(`[${groupId}] 连续回复过多，静默`);
        return;
      }

      const lastReply = buffer.getLastBotReply(groupId);
      if (lastReply && Date.now() - lastReply.timestamp < config.safety.minCooldownMs) {
        logger.debug(`[${groupId}] 冷却中`);
        return;
      }

      if (state.botMutedGroups.get(groupId)) {
        logger.debug(`[${groupId}] 机器人被禁言中，跳过 LLM 请求`);
        return;
      }

      await waitForPendingImages(groupId, controller.signal);
      if (controller.signal.aborted) {
        logger.debug(`[${groupId}] 请求已被取消（等待图片时）`);
        return;
      }

      newMessages = getNewMessages(groupId);
      if (newMessages.length === 0) {
        logger.debug(`[${groupId}] 没有新消息，跳过`);
        return;
      }
      const newMessageIds = new Set(newMessages.map((m) => m.id));
      const newMessageMarker = newMessages.map((msg) => renderer.renderMessage(msg)).join("\n");

      let memoryUserProfile: string | undefined;
      let memoryMemories: string | undefined;
      let memoryGroupCulture: string | undefined;
      if (memory) {
        try {
          const participantIds = [...new Set(newMessages.map((m) => m.senderId))];
          const allBuffered = buffer.getRecent(groupId);
          const memCtx = await memory.getMemoryContext(groupId, participantIds, newMessages, allBuffered);
          if (memCtx.userProfile) memoryUserProfile = memCtx.userProfile;
          if (memCtx.memories) memoryMemories = memCtx.memories;
          if (memCtx.groupCulture) memoryGroupCulture = memCtx.groupCulture;
        } catch (err) {
          logger.warn("记忆读取失败:", err);
        }
      }

      const allMessages = buffer.getRecent(groupId);
      const { text: recentMessagesText, msgMap } = renderer.render(allMessages, new Set(), newMessageIds);
      const currentStickerSummary = stickerService?.getSummary() || undefined;
      const systemPrompt = promptBuilder.buildSystemPrompt({
        recentMessages: recentMessagesText,
        userProfile: memoryUserProfile,
        groupCulture: memoryGroupCulture,
        memories: memoryMemories,
        stickerSummary: currentStickerSummary,
      });

      const fiveMinAgo = Date.now() - 5 * 60_000;
      const recentBotCount = buffer.getRecent(groupId).filter((m) => m.isBot && m.timestamp > fiveMinAgo).length;
      const userPrompt = promptBuilder.buildUserPrompt(newMessageMarker, recentBotCount);

      if (memoryUserProfile || memoryMemories || memoryGroupCulture || currentStickerSummary) {
        logger.debug(
          `[${groupId}] === 记忆注入摘要 ===` +
            (memoryUserProfile ? `\n[userProfile]\n${memoryUserProfile}` : "") +
            (memoryMemories ? `\n[memories]\n${memoryMemories}` : "") +
            (memoryGroupCulture ? `\n[groupCulture]\n${memoryGroupCulture}` : "") +
            (currentStickerSummary ? `\n[stickerSummary]\n${currentStickerSummary}` : ""),
        );
      }

      logger.debug(`[${groupId}] 本轮新消息 (${newMessages.length} 条):\n${newMessageMarker}`);
      logger.debug("调用 LLM...");
      const response = await llm.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        config.models.chat,
        {
          signal: controller.signal,
          responseFormat: "json_object",
          purpose: "conversation",
        },
      );

      if (controller.signal.aborted) {
        logger.debug(`[${groupId}] 请求已被取消（LLM 返回后）`);
        return;
      }

      logger.info(`LLM 响应: ${response.content} (tokens: ${response.usage.promptTokens}+${response.usage.completionTokens})`);

      let parsedResponse: LLMResponse;
      try {
        const jsonMatch = response.content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          logger.warn("LLM 输出不包含 JSON，跳过");
          return;
        }
        parsedResponse = JSON.parse(jsonMatch[0]);
        parsedResponse.silent = (parsedResponse.urge ?? 10) < SILENCE_THRESHOLD;
      } catch (error) {
        logger.error("解析 LLM JSON 输出失败:", error);
        logger.debug("原始输出:", response.content);
        return;
      }

      validateResponse(parsedResponse, logger);
      logger.debug(`思考: ${parsedResponse.thought}`);
      logger.debug(`搜索: ${parsedResponse.search ? JSON.stringify(parsedResponse.search) : "null"}`);
      logger.debug(`冲动: ${parsedResponse.urge ?? "N/A"} → ${parsedResponse.silent ? "沉默" : "说话"}`);

      // Shadow mode: log and skip all actions
      if (shadowLogger && config.shadowGroups.includes(groupId)) {
        const messageSummary = newMessages.map((m) => ({
          sender: m.sender,
          content: m.segments.map((s) => ("content" in s ? s.content : null) || `[${s.type}]`).join(""),
        }));
        shadowLogger.log({
          groupId,
          phase: "main",
          newMessages: messageSummary,
          thought: parsedResponse.thought,
          urge: parsedResponse.urge ?? -1,
          silent: parsedResponse.silent,
          actions: parsedResponse.actions || null,
          search: parsedResponse.search || null,
        });
        logger.debug(`[${groupId}] [shadow] 已记录 LLM 响应 (urge=${parsedResponse.urge}, silent=${parsedResponse.silent})`);
        if (newMessages.length > 0) {
          state.lastRespondedAt.set(groupId, newMessages[newMessages.length - 1].timestamp);
        }
        return;
      }

      if (parsedResponse.search) {
        if (parsedResponse.search.target_msg_id && parsedResponse.search.hint !== "image") {
          logger.warn(
            `[${groupId}] LLM 搭配错误：target_msg_id="${parsedResponse.search.target_msg_id}" ` +
              `配了 hint="${parsedResponse.search.hint}"，自动纠正为 hint="image"`,
          );
          parsedResponse.search.hint = "image";
          delete (parsedResponse.search as any).query;
        }
        logger.debug("LLM 请求搜索，执行搜索流程");
        await handleSearch(
          parsedResponse.search,
          newMessages,
          msgMap,
          groupId,
          session,
          controller.signal,
        );
        return;
      }

      if (parsedResponse.silent) {
        logger.debug("LLM 选择沉默，不发送消息");
        if (newMessages.length > 0) {
          const lastNewMessageTime = newMessages[newMessages.length - 1].timestamp;
          state.lastRespondedAt.set(groupId, lastNewMessageTime);
          logger.debug(`[${groupId}] 推进指针到最后一条新消息: ${new Date(lastNewMessageTime).toLocaleTimeString()}`);
        }
        return;
      }

      if (!parsedResponse.actions || parsedResponse.actions.length === 0) {
        logger.warn("LLM 返回 silent=false 但 actions 为空，跳过");
        return;
      }

      const hasSentMessage = await executeActions(parsedResponse.actions, msgMap, groupId, session, controller.signal);
      if (hasSentMessage) {
        debouncer.markSpoke(groupId);
        state.hourlyReplies.set(groupId, hourCount + 1);
      }

      state.lastRespondedAt.set(groupId, newMessages[newMessages.length - 1].timestamp);
    } catch (error) {
      if (error.name === "AbortError") {
        logger.debug(`[${groupId}] 请求被取消`);
        return;
      }
      logger.error("处理消息时出错:", error);
      if (newMessages && newMessages.length > 0) {
        state.lastRespondedAt.set(groupId, newMessages[newMessages.length - 1].timestamp);
        logger.debug(`[${groupId}] 出错后推进指针，避免重试风暴`);
      }
    } finally {
      if (state.activeRequests.get(groupId) === controller) {
        state.activeRequests.delete(groupId);
      }
      if (controller.signal.aborted) return;

      const unhandled = getNewMessages(groupId);
      if (unhandled.length > 0) {
        logger.debug(`[${groupId}] 处理期间有 ${unhandled.length} 条新消息，重新启动 debounce`);
        debouncer.restart(groupId, async () => {
          await processConversation(groupId, session, false);
        });
      }
    }
  }

  return {
    processConversation,
    triggerMemoryExtraction,
  };
}

import { Universal } from "koishi";
import { RuntimeDeps, RuntimeState } from "./types";

export function registerHistoryAndReadyHandlers(
  deps: RuntimeDeps,
  state: RuntimeState,
  triggerMemoryExtraction: (groupId: string, reason: string) => Promise<void>,
): void {
  const { buffer, config, ctx, extractionScheduler, logger, normalizer } = deps;

  let historyLoaded = false;

  async function preloadHistoryMessages() {
    if (historyLoaded) return;
    historyLoaded = true;

    logger.info("开始预加载历史消息...");
    for (const groupId of config.enableGroups) {
      try {
        const bot = ctx.bots[0];
        if (!bot) {
          logger.warn(`[${groupId}] 没有可用的 bot`);
          continue;
        }

        const allMessages: any[] = [];
        let next: string | undefined = undefined;
        const maxIterations = 10;
        let iteration = 0;
        while (allMessages.length < config.bufferSize && iteration < maxIterations) {
          iteration++;
          const messageList = await bot.getMessageList(groupId, next, "before", config.bufferSize);
          if (!messageList?.data || messageList.data.length === 0) break;
          allMessages.push(...messageList.data);
          if (messageList.next) {
            next = messageList.next;
          } else {
            break;
          }
        }

        if (allMessages.length === 0) {
          logger.info(`[${groupId}] 没有历史消息`);
          continue;
        }

        const sortedMessages = allMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        const messagesToLoad = sortedMessages.slice(-config.bufferSize);
        let latestTimestamp = 0;

        for (const msg of messagesToLoad) {
          const fakeSession: any = {
            elements: msg.elements,
            content: msg.content,
            quote: msg.quote,
            event: {
              message: msg,
              member: msg.member,
            },
            author: msg.user,
            username: msg.member?.nick || msg.user?.nick || msg.user?.name,
            userId: msg.user?.id,
            timestamp: msg.timestamp,
            selfId: bot.selfId,
            guildId: groupId,
            bot,
          };

          const normalizedMsg = await normalizer.normalize(fakeSession, true, buffer);
          const timestamp = normalizedMsg.timestamp;
          buffer.push(groupId, normalizedMsg);
          if (timestamp > latestTimestamp) latestTimestamp = timestamp;
        }

        state.lastRespondedAt.set(groupId, latestTimestamp);
        if (extractionScheduler) {
          extractionScheduler.markExtracted(groupId);
        }

        const botMessageCount = messagesToLoad.filter((m) => m.user?.id === bot.selfId).length;
        logger.info(`[${groupId}] 预加载了 ${messagesToLoad.length} 条历史消息（包含 bot 消息: ${botMessageCount} 条）`);
      } catch (error) {
        logger.warn(`[${groupId}] 预加载历史消息失败:`, error);
        historyLoaded = false;
      }
    }

    logger.info("历史消息预加载完成");
  }

  ctx.on("bot-status-updated", async (bot) => {
    if (bot.status !== Universal.Status.ONLINE) return;
    await preloadHistoryMessages();
  });

  ctx.on("ready", async () => {
    for (const bot of ctx.bots) {
      if (bot.status === Universal.Status.ONLINE) {
        await preloadHistoryMessages();
        break;
      }
    }

    if (extractionScheduler) {
      for (const groupId of config.enableGroups) {
        if (extractionScheduler.getLastExtractedAt(groupId) === 0) {
          extractionScheduler.markExtracted(groupId);
          logger.debug(`[${groupId}] 初始化记忆提取时间戳`);
        }
      }

      extractionScheduler.startTimeoutChecker(config.enableGroups, async (groupId) => {
        logger.debug(`[${groupId}] 记忆提取超时触发`);
        await triggerMemoryExtraction(groupId, "timeout");
      });
    }
  });
}

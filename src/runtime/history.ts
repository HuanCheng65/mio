import { Universal } from "koishi";
import { RuntimeDeps, RuntimeState } from "./types";
import { parseGroupId } from "./groups";

export function registerHistoryAndReadyHandlers(
  deps: RuntimeDeps,
  state: RuntimeState,
  triggerMemoryExtraction: (groupId: string, reason: string) => Promise<void>,
): { preloadGroup: (groupId: string) => Promise<void> } {
  const { buffer, config, ctx, extractionScheduler, groups, logger, normalizer } = deps;

  const preloadedGroups = new Set<string>();

  async function preloadGroup(groupId: string) {
    if (preloadedGroups.has(groupId)) return;

    const { platform, channelId } = parseGroupId(groupId);
    const bot = ctx.bots.find((b) => b.platform === platform && b.status === Universal.Status.ONLINE);
    if (!bot) {
      logger.debug(`[${groupId}] 没有在线的 ${platform} bot，稍后再预加载`);
      return;
    }

    if (!(await bot.supports("message.list"))) {
      // 官方 QQ 等平台没有拉取历史消息的接口，只能从开启后收到的消息开始积累
      logger.info(`[${groupId}] ${platform} 平台不支持拉取历史消息，跳过预加载`);
      preloadedGroups.add(groupId);
      return;
    }

    try {
      const allMessages: any[] = [];
      let next: string | undefined = undefined;
      const maxIterations = 10;
      let iteration = 0;
      while (allMessages.length < config.bufferSize && iteration < maxIterations) {
        iteration++;
        const messageList = await bot.getMessageList(channelId, next, "before", config.bufferSize);
        if (!messageList?.data || messageList.data.length === 0) break;
        allMessages.push(...messageList.data);
        if (messageList.next) {
          next = messageList.next;
        } else {
          break;
        }
      }

      preloadedGroups.add(groupId);
      if (allMessages.length === 0) {
        logger.info(`[${groupId}] 没有历史消息`);
        return;
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
          platform,
          channelId,
          guildId: channelId,
          cid: groupId,
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
    }
  }

  async function preloadAllGroups() {
    logger.info("开始预加载历史消息...");
    for (const groupId of groups.list()) {
      await preloadGroup(groupId);
    }
    logger.info("历史消息预加载完成");
  }

  let groupsLoaded = false;

  ctx.on("bot-status-updated", async (bot) => {
    if (!groupsLoaded || bot.status !== Universal.Status.ONLINE) return;
    await preloadAllGroups();
  });

  ctx.on("ready", async () => {
    await groups.load();
    groupsLoaded = true;
    logger.info(`已启用的群: ${groups.list().join(", ") || "无"}`);

    await preloadAllGroups();

    if (extractionScheduler) {
      for (const groupId of groups.list()) {
        if (extractionScheduler.getLastExtractedAt(groupId) === 0) {
          extractionScheduler.markExtracted(groupId);
          logger.debug(`[${groupId}] 初始化记忆提取时间戳`);
        }
      }

      extractionScheduler.startTimeoutChecker(() => groups.list(), async (groupId) => {
        logger.debug(`[${groupId}] 记忆提取超时触发`);
        await triggerMemoryExtraction(groupId, "timeout");
      });
    }
  });

  return { preloadGroup };
}

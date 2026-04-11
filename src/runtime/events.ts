import { getEmojiById } from "../emoji/lookup";
import type { Session } from "koishi";
import { RuntimeDeps, RuntimeState } from "./types";
import { isMentioningBot } from "../helpers";

export function registerRuntimeEvents(
  deps: RuntimeDeps,
  state: RuntimeState,
  processConversation: (groupId: string, session: Session, isMentioned?: boolean) => Promise<void>,
  triggerMemoryExtraction: (groupId: string, reason: string) => Promise<void>,
): void {
  const { buffer, config, ctx, extractionScheduler, imageProcessor, logger, normalizer, renderer, stickerService } = deps;

  function resolveNameFromBuffer(groupId: string, userId: string): string {
    const recent = buffer.getRecent(groupId);
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].senderId === userId) return recent[i].sender;
    }
    return userId;
  }

  ctx.on("internal/session", async (session) => {
    if (session.type !== "notice" || session.subtype !== "group-msg-emoji-like") return;

    const data = (session as any).onebot as
      | {
          message_id?: string | number;
          user_id?: string | number;
          group_id?: string | number;
          likes?: Array<{ emoji_id: string; count: number }>;
        }
      | undefined;
    if (!data) return;

    const msgId = String(data.message_id ?? "");
    const userId = String(data.user_id ?? "");
    const likes = data.likes ?? [];
    logger.debug(`[reaction] msgId=${msgId} userId=${userId} likes=${JSON.stringify(likes)}`);

    for (const like of likes) {
      const emoji = getEmojiById(String(like.emoji_id));
      const emojiName = emoji?.name ?? `表情${like.emoji_id}`;
      const isAdd = like.count > 0;
      buffer.handleReaction(msgId, emojiName, userId, isAdd, session.selfId, like.count);
    }
  });

  ctx.on("internal/session", async (session) => {
    if (session.type !== "guild-member" && session.subtype !== "ban") return;
    const data = (session as any).onebot as
      | {
          notice_type?: string;
          sub_type?: string;
          group_id?: string | number;
          user_id?: string | number;
          operator_id?: string | number;
          duration?: number;
        }
      | undefined;
    if (!data || data.notice_type !== "group_ban") return;

    const groupId = String(data.group_id ?? "");
    if (!groupId || !config.enableGroups.includes(groupId)) return;

    const userId = String(data.user_id ?? "");
    const operatorId = String(data.operator_id ?? "");
    const duration = data.duration ?? 0;
    const isLift = data.sub_type === "lift_ban";
    const isSelf = userId === session.selfId;

    const targetName = isSelf ? config.botName : resolveNameFromBuffer(groupId, userId);
    const operatorName = resolveNameFromBuffer(groupId, operatorId);

    let noticeText: string;
    if (isLift) {
      noticeText = `（${operatorName} 解除了 ${targetName} 的禁言）`;
    } else {
      const durationMin = Math.round(duration / 60);
      noticeText =
        durationMin > 0 ? `（${operatorName} 将 ${targetName} 禁言了 ${durationMin} 分钟）` : `（${operatorName} 将 ${targetName} 禁言了）`;
    }

    buffer.push(groupId, {
      id: crypto.randomUUID(),
      sender: "系统",
      senderId: "system",
      isBot: false,
      isSystemEvent: true,
      timestamp: Date.now(),
      segments: [{ type: "notice", content: noticeText }],
      mentions: [],
    });
    logger.debug(`[${groupId}] 禁言通知: ${noticeText}`);

    if (isSelf) {
      if (isLift) {
        state.botMutedGroups.delete(groupId);
        logger.info(`[${groupId}] 机器人禁言已解除`);
      } else {
        state.botMutedGroups.set(groupId, true);
        logger.info(`[${groupId}] 机器人已被禁言`);
      }
    }
  });

  ctx.on("message-deleted", async (session) => {
    const groupId = session.event?.channel?.id || session.guildId;
    if (!groupId || !config.enableGroups.includes(groupId)) return;
    const recalledMsgId = session.messageId;
    if (!recalledMsgId) return;

    const recalledByName =
      session.event?.member?.nick || session.author?.nick || session.author?.name || session.username || session.userId || "某人";

    const notice = normalizer.handleRecall(recalledMsgId, recalledByName, buffer);
    if (notice) {
      buffer.push(groupId, notice);
      logger.debug(`[${groupId}] 撤回通知已记录: ${recalledMsgId}`);
    }
  });

  ctx.on("message", async (session) => {
    if (session.event.channel?.type !== 0) return;
    const groupId = session.event.channel?.id;
    if (!groupId || !config.enableGroups.includes(groupId)) return;

    const msg = await normalizer.normalize(session, false, buffer);
    const messageId = msg.id;

    if (imageProcessor && session.elements?.some((el) => el.type === "img" || el.type === "image")) {
      const images = imageProcessor.extractImages(session);
      if (images.length > 0) {
        const imageTaskPromise = Promise.all(
          images.map(async (img) => {
            const analysis = await imageProcessor.analyzeImage(img.url);
            logger.debug(`[sticker] VLM决策: type=${analysis.type} collect=${analysis.collect ?? false} | "${analysis.description.slice(0, 40)}"`);
            if (analysis.type === "sticker" && analysis.collect) {
              logger.debug(`[sticker] 收藏元数据: vibe="${analysis.sticker_vibe}" style="${analysis.sticker_style}" scene="${analysis.sticker_scene}"`);
            }
            if (stickerService && analysis.type === "sticker" && analysis.collect) {
              imageProcessor
                .downloadBuffer(img.url)
                .then((buf) => {
                  if (buf) {
                    stickerService.maybeCollect(img.url, buf, analysis, msg.sender).catch((err) => logger.warn("[sticker] 收集失败:", err));
                  }
                })
                .catch((err) => logger.warn("[sticker] 图片下载失败:", err));
            }
            return analysis.description;
          }),
        )
          .then((descriptions) => {
            const description = descriptions[0] || null;
            logger.debug(`[${groupId}] 图片处理完成: ${description}`);
            return description;
          })
          .catch((err) => {
            logger.error(`[${groupId}] 图片处理失败:`, err);
            return null;
          });

        if (!state.pendingImageTasks.has(groupId)) {
          state.pendingImageTasks.set(groupId, []);
        }
        state.pendingImageTasks.get(groupId)!.push({
          messageId,
          promise: imageTaskPromise,
          startTime: Date.now(),
        });
      }
    }

    buffer.push(groupId, msg);

    if (extractionScheduler) {
      const decision = extractionScheduler.onNewMessage(groupId, msg.isBot);
      logger.debug(`[${groupId}] 记忆提取待处理: ${decision.pendingCount} 条消息`);
      if (decision.shouldExtract) {
        triggerMemoryExtraction(groupId, decision.reason!).catch((err) => {
          logger.warn(`[${groupId}] 记忆提取失败:`, err);
        });
      }
    }

    if (msg.isBot) return;

    const renderedText = renderer.renderContent(msg);
    const mentionsBot = isMentioningBot(renderedText, config);
    const repliesToBot = !!(msg.replyTo && buffer.findById(msg.replyTo.messageId)?.isBot);
    const engaged = mentionsBot || repliesToBot;

    deps.debouncer.onMessage(groupId, msg, engaged, async () => {
      await processConversation(groupId, session, engaged);
    });
  });
}

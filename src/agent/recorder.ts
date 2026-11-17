import { Context, Session } from "koishi";
import type { MessageNormalizer } from "../perception/normalizer";
import type { ImageSegment } from "../perception/types";
import { getEmojiById } from "../emoji/lookup";
import { toGroupId, type GroupRegistry } from "../runtime/groups";
import type { BanBody, EventStore, MioEventRow, NewEvent, ReactionBody } from "./event-store";
import type { MediaStore } from "./media-store";
import { resolveQQReply } from "./qq-refs";

type Logger = ReturnType<Context["logger"]>;

/** OneBot 通知的原始字段（adapter 放在 session.onebot 上） */
interface OneBotNotice {
  post_type?: string;
  notice_type?: string;
  sub_type?: string;
  group_id?: string | number;
  user_id?: string | number;
  operator_id?: string | number;
  duration?: number;
  message_id?: string | number;
  likes?: { emoji_id: string | number; count: number }[];
}

/** 录下一条群友消息、禁言或表情回应之后调用（新运行时据此唤醒或更新状态） */
export type RecordListener = (groupId: string, session: Session, event: MioEventRow) => void;

/**
 * 把开启了 mio 的群的聊天写进事件流。群友消息走中间件，排在 Koishi 指令处理之后，
 * 所以被当作指令执行的消息不会被录下来。不依赖任何模型配置。
 */
export function registerRecorder(
  ctx: Context,
  deps: {
    groups: GroupRegistry;
    normalizer: MessageNormalizer;
    events: EventStore;
    media: MediaStore;
    logger: Logger;
    botName: string;
    /** 可在注册后追加（新运行时启动时加入） */
    listeners: RecordListener[];
  },
): void {
  const { groups, normalizer, events, media, logger, botName, listeners } = deps;

  async function saveImages(groupId: string, segments: { type: string }[]): Promise<void> {
    for (const seg of segments) {
      if (seg.type !== "image") continue;
      const image = seg as ImageSegment;
      try {
        image.file = await media.save(image.url);
      } catch (err) {
        // 图片链接失效或超时不应该让整条消息丢失：保留 url，记下原因
        logger.warn(`[${groupId}] 录制图片失败，只保留链接: ${err}`);
      }
    }
  }

  async function recordMessage(session: Session): Promise<void> {
    if (session.isDirect || !session.channelId) return;
    const groupId = session.cid;
    if (!groups.isRecorded(groupId)) return;

    const event = await events.append(groupId, async () => {
      const msg = await normalizer.normalize(session);
      await saveImages(groupId, msg.segments);
      await resolveQQReply(ctx, events, groupId, msg, botName);
      return {
        kind: "message",
        platformMessageId: msg.id,
        userId: msg.senderId,
        isBot: msg.isBot,
        timestamp: msg.timestamp,
        body: msg,
        refIdx: msg.refIdx ?? null,
      };
    });
    for (const listener of listeners) listener(groupId, session, event);
  }

  ctx.middleware((session, next) => {
    recordMessage(session).catch((err) => logger.error(`[${session.cid}] 录制消息失败:`, err));
    return next();
  });

  function recordNotice(groupId: string, session: Session, prepare: () => NewEvent, what: string): void {
    events
      .append(groupId, async () => prepare())
      .then((event) => {
        for (const listener of listeners) listener(groupId, session, event);
      })
      .catch((err) => logger.error(`[${groupId}] 录制${what}失败:`, err));
  }

  // 禁言和表情回应只有 OneBot 推送；官方 QQ 群没有这些事件
  ctx.on("internal/session", (session) => {
    if (session.platform !== "onebot") return;
    const data = (session as Session & { onebot?: OneBotNotice }).onebot;
    if (!data || data.post_type !== "notice" || data.group_id === undefined) return;
    const groupId = toGroupId(session.platform, String(data.group_id));
    if (!groups.isRecorded(groupId)) return;

    if (data.notice_type === "group_ban") {
      const lift = data.sub_type === "lift_ban";
      const target = String(data.user_id);
      // user_id 为 0 是全员禁言
      const targetId = target === "0" ? null : target;
      recordNotice(groupId, session, () => ({
        kind: "ban",
        platformMessageId: "",
        userId: String(data.operator_id),
        isBot: false,
        timestamp: Date.now(),
        body: {
          operatorId: String(data.operator_id),
          targetId,
          targetIsSelf: targetId === null || targetId === session.selfId,
          lift,
          // 全员禁言不带时长，记成 0：直到解除
          durationSec: lift ? 0 : Math.max(0, Number(data.duration ?? 0)),
        } satisfies BanBody,
      }), "禁言");
      return;
    }

    if (data.notice_type === "group_msg_emoji_like") {
      const userId = String(data.user_id);
      if (userId === session.selfId) return;
      for (const like of data.likes ?? []) {
        const emoji = getEmojiById(String(like.emoji_id))?.name ?? `表情${like.emoji_id}`;
        recordNotice(groupId, session, () => ({
          kind: "reaction",
          platformMessageId: "",
          userId,
          isBot: false,
          timestamp: Date.now(),
          body: { messageId: String(data.message_id), userId, emoji, add: like.count > 0 } satisfies ReactionBody,
        }), "表情回应");
      }
    }
  });

  ctx.on("message-deleted", (session) => {
    if (session.isDirect || !session.channelId || !session.messageId) return;
    const groupId = session.cid;
    if (!groups.isRecorded(groupId)) return;
    const recalledBy = session.event?.member?.nick || session.author?.nick || session.author?.name || session.userId || "";
    events
      .append(groupId, async () => ({
        kind: "recall",
        platformMessageId: session.messageId,
        userId: session.userId ?? "",
        isBot: false,
        timestamp: session.timestamp || Date.now(),
        body: { recalledMessageId: session.messageId, recalledBy },
      }))
      .catch((err) => logger.error(`[${groupId}] 录制撤回失败:`, err));
  });
}

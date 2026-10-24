import { Context, Session } from "koishi";
import type { MessageNormalizer } from "../perception/normalizer";
import type { ImageSegment } from "../perception/types";
import type { GroupRegistry } from "../runtime/groups";
import type { EventStore } from "./event-store";
import type { MediaStore } from "./media-store";

type Logger = ReturnType<Context["logger"]>;

/**
 * 把开启了 mio 的群的聊天写进事件流。群友消息走中间件，排在 Koishi 指令处理之后，
 * 所以被当作指令执行的消息不会被录下来。不依赖任何模型配置。
 */
export function registerRecorder(
  ctx: Context,
  deps: { groups: GroupRegistry; normalizer: MessageNormalizer; events: EventStore; media: MediaStore; logger: Logger },
): void {
  const { groups, normalizer, events, media, logger } = deps;

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

    await events.append(groupId, async () => {
      const msg = await normalizer.normalize(session, true);
      await saveImages(groupId, msg.segments);
      return {
        kind: "message",
        platformMessageId: msg.id,
        userId: msg.senderId,
        isBot: msg.isBot,
        timestamp: msg.timestamp,
        body: msg,
      };
    });
  }

  ctx.middleware((session, next) => {
    recordMessage(session).catch((err) => logger.error(`[${session.cid}] 录制消息失败:`, err));
    return next();
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

import { Session } from "koishi";
import { ImageProcessor } from "../pipeline/image-processor";
import { MessageBuffer } from "../pipeline/message-buffer";
import { getEmojiById } from '@wittf/koishi-plugin-adapter-onebot';
import {
  NormalizedMessage,
  MessageSegment,
  MentionInfo,
  ReplyInfo,
  ImageSegment,
  ShareSegment
} from "./types";
import crypto from "crypto";

export class MessageNormalizer {
  // 群成员身份/称号缓存，key = `${guildId}:${userId}`，TTL 5 分钟
  private titleCache = new Map<string, {
    value: { role: '群主' | '管理员' | undefined; title: string | undefined };
    expires: number;
  }>();
  private static TITLE_TTL_MS = 5 * 60 * 1000;

  constructor(
    private imageProcessor: ImageProcessor | null,
    private configBotName: string,
  ) {}

  async normalize(session: Session, skipImageUnderstanding: boolean = false, buffer?: MessageBuffer): Promise<NormalizedMessage> {
    const segments: MessageSegment[] = [];
    const mentions: MentionInfo[] = [];
    const botId = session.selfId;

    // 1. 处理 elements
    if (session.elements && session.elements.length > 0) {
      for (const el of session.elements) {
        const result = await this.normalizeElement(el, session, skipImageUnderstanding);
        if (result.segment) segments.push(result.segment);
        if (result.mention) mentions.push(result.mention);
      }
    } else if (session.content) {
      segments.push({
        type: 'text',
        content: this.stripHtml(session.content),
      });
    }

    // 2. 处理引用
    const replyTo = await this.extractReply(session, buffer);

    // 3. UID / 消息ID 兜底
    const msgId = session.messageId || session.event?.message?.id || crypto.randomUUID();

    // 4. 组装
    const { role: senderRole, title: senderTitle } = await this.resolveSenderInfo(session);
    return {
      id: msgId,
      sender: this.resolveSenderName(session),
      senderId: session.userId || "unknown",
      senderRole,
      senderTitle,
      isBot: session.userId === botId,
      timestamp: session.timestamp || Date.now(),
      segments,
      replyTo,
      mentions,
      rawContent: session.content,
    };
  }

  private async normalizeElement(
    el: any,
    session: Session,
    skipImageUnderstanding: boolean
  ): Promise<{ segment?: MessageSegment; mention?: MentionInfo }> {
    switch (el.type) {
      case 'text': {
        const content = el.attrs?.content || '';
        if (!content) return {};
        // 合并相邻文本段在渲染时不需要，但我们这里正常保留
        return { segment: { type: 'text', content } };
      }

      case 'at': {
        const targetId = el.attrs?.id;
        const botId = session.selfId;
        const isBot = targetId === botId;
        const displayName = isBot
          ? this.configBotName
          : await this.resolveUserName(el, session);

        return {
          segment: { type: 'text', content: `@${displayName}` },
          mention: { userId: targetId || "unknown", displayName, isBot },
        };
      }

      case 'img':
      case 'image': {
        const url = el.attrs?.src || el.attrs?.url;
        if (!url) return { segment: { type: 'unsupported', hint: '[图片:无法获取]' } };

        const isSticker = this.detectSticker(el);

        let description: string | null = null;
        if (this.imageProcessor) {
          const cached = this.imageProcessor.getCachedSync(url);
          if (cached) {
            description = cached;
          } else if (skipImageUnderstanding) {
            description = null;
          } else {
            // For now we set null, the outer process logic triggers ImageProcessor
            // But per standard design, Normalizer could trigger it async itself.
            // We'll leave it null for async update.
            description = null; 
          }
        }

        const segment: ImageSegment = {
          type: 'image',
          url,
          description,
          isSticker,
          width: el.attrs?.width ? Number(el.attrs.width) : undefined,
          height: el.attrs?.height ? Number(el.attrs.height) : undefined,
        };

        return { segment };
      }

      case 'face': {
        const faceId = el.attrs?.id;
        const emoji = getEmojiById(String(faceId));
        const name = emoji ? emoji.name : `表情${faceId}`;
        return { segment: { type: 'face', faceId: Number(faceId), name } };
      }

      case 'json':
      case 'share': {
        return { segment: this.parseShareCard(el) };
      }

      case 'forward': {
        const count = el.attrs?.count || '?';
        return {
          segment: {
            type: 'forward',
            summary: `聊天记录（${count}条）`,
          },
        };
      }

      case 'poke': {
        const target = el.attrs?.id;
        const targetName = await this.resolveUserName(el, session);
        return {
          segment: {
            type: 'poke',
            target: targetName || target,
            action: el.attrs?.type || '戳了戳',
          },
        };
      }

      case 'file': {
        const name = el.attrs?.name || '未知文件';
        return { segment: { type: 'unsupported', hint: `[文件: ${name}]` } };
      }

      case 'video': {
        return { segment: { type: 'unsupported', hint: '[视频]' } };
      }

      case 'audio':
      case 'record': {
        return { segment: { type: 'unsupported', hint: '[语音]' } };
      }

      default: {
        return { segment: { type: 'unsupported', hint: `[未知内容:${el.type}]` } };
      }
    }
  }

  private async extractReply(session: Session, buffer?: MessageBuffer): Promise<ReplyInfo | undefined> {
    const quote = session.quote || session.event?.message?.quote;
    if (!quote) return undefined;

    const sender = quote.member?.nick || quote.user?.name || quote.user?.nick || '某人';

    // Fast path: look up the quoted message in the buffer by ID.
    // The buffered message already has resolved image descriptions.
    if (buffer && quote.id) {
      const buffered = buffer.findById(quote.id);
      if (buffered) {
        let preview = this.buildPreviewFromSegments(buffered.segments);
        if (!preview && quote.content) {
          preview = quote.content.replace(/<[^>]+>/g, '').trim();
        }
        if (preview.length > 40) preview = preview.slice(0, 40) + '...';
        return { messageId: quote.id, sender, preview };
      }
    }

    // 优先走完整的 normalizeElement 管线处理 quote.elements
    // skipImageUnderstanding=true：引用预览不需要理解图片内容，只标注 [图片]
    let preview = '';
    if (quote.elements && quote.elements.length > 0) {
      const parts: string[] = [];
      for (const el of quote.elements) {
        const result = await this.normalizeElement(el, session, true);
        if (!result.segment) continue;
        const seg = result.segment;
        switch (seg.type) {
          case 'text':    parts.push(seg.content); break;
          case 'face':    parts.push(`[${seg.name}]`); break;
          case 'image':   parts.push(seg.isSticker ? '[表情包]' : (seg.description ? `[图片：${seg.description}]` : '[图片]')); break;
          case 'share':   parts.push(`[分享：${seg.title}]`); break;
          case 'forward': parts.push(`[${seg.summary}]`); break;
          case 'poke':    parts.push(`[${seg.action}]`); break;
          case 'unsupported': if (seg.hint) parts.push(seg.hint); break;
        }
      }
      preview = parts.join('').trim();
    }

    // fallback：如果 elements 没有或处理结果为空，用 content 做兜底
    if (!preview) {
      preview = quote.content?.replace(/<[^>]+>/g, '').trim() || '';
    }

    if (preview.length > 40) preview = preview.slice(0, 40) + '...';

    return {
      messageId: quote.id || '',
      sender,
      preview,
    };
  }

  private parseShareCard(el: any): ShareSegment {
    if (el.type === 'share') {
      return {
        type: 'share',
        subtype: 'link',
        title: el.attrs?.title || '链接',
        description: el.attrs?.content,
        url: el.attrs?.url,
      };
    }

    try {
      const data = JSON.parse(el.attrs?.data || '{}');
      const meta = data.meta || {};
      const detail = meta.detail_1 || meta.music || meta.news || {};
      const app = data.app || '';

      let subtype: ShareSegment['subtype'] = 'unknown';
      if (app.includes('music') || meta.music) subtype = 'music';
      else if (app.includes('video') || app.includes('bilibili')) subtype = 'video';
      else if (app.includes('miniapp') || data.view === 'miniapp') subtype = 'miniapp';
      else if (detail.title || data.prompt) subtype = 'link';

      return {
        type: 'share',
        subtype,
        title: detail.title || data.prompt || '卡片消息',
        description: detail.desc || detail.preview,
        platform: this.detectPlatform(app, data.prompt, detail),
        url: detail.qqdocurl || detail.jumpUrl,
      };
    } catch {
      return {
        type: 'share',
        subtype: 'unknown',
        title: el.attrs?.data?.slice(0, 30) || '卡片结构',
      };
    }
  }

  private detectPlatform(app: string, prompt: string, detail: any): string | undefined {
    const text = `${app} ${prompt} ${detail?.title || ''}`.toLowerCase();
    if (text.includes('163') || text.includes('netease') || text.includes('网易云')) return '网易云音乐';
    if (text.includes('qq音乐') || text.includes('qqmusic')) return 'QQ音乐';
    if (text.includes('bilibili') || text.includes('b站') || text.includes('哔哩')) return 'B站';
    if (text.includes('douyin') || text.includes('抖音')) return '抖音';
    if (text.includes('spotify')) return 'Spotify';
    return undefined;
  }

  private resolveSenderName(session: Session): string {
    return session.event?.member?.nick
      || session.author?.nick
      || session.author?.name
      || session.username
      || session.userId
      || "某人";
  }

  /**
   * 解析发送者的群内身份和自定义称号（async，带 TTL 缓存）。
   * 因为消息事件本身不携带 role/title，需主动调 getGroupMemberInfo 拉取。
   *
   * 返回: { role: '群主'|'管理员'|undefined, title: 自定义称号|undefined }
   */
  private async resolveSenderInfo(session: Session): Promise<{
    role: '群主' | '管理员' | undefined;
    title: string | undefined;
  }> {
    const guildId = session.guildId;
    const userId = session.userId;
    if (!guildId || !userId) return { role: undefined, title: undefined };

    const cacheKey = `${guildId}:${userId}`;
    const cached = this.titleCache.get(cacheKey);
    if (cached && Date.now() < cached.expires) {
      return cached.value;
    }

    try {
      const info = await session.bot.internal.getGroupMemberInfo(guildId, userId, false);

      const role: '群主' | '管理员' | undefined =
        info?.role === 'owner' ? '群主' :
        info?.role === 'admin' ? '管理员' :
        undefined;

      const title = (info?.title as string | undefined)?.trim() || undefined;

      const result = { role, title };
      // 复用 titleCache，.title 字段存放 {role, title} 对象
      this.titleCache.set(cacheKey, { value: result, expires: Date.now() + MessageNormalizer.TITLE_TTL_MS });
      return result;
    } catch {
      return { role: undefined, title: undefined };
    }
  }

  private async resolveUserName(el: any, session: Session): Promise<string> {
    const targetId = el.attrs?.id;
    let name = el.attrs?.name;

    if (!name && targetId && session.guildId) {
      try {
        const member = await session.bot.getGuildMember(session.guildId, targetId);
        name = member?.nick || member?.user?.nick || member?.user?.name;
      } catch { }
    }

    return name || targetId || '未知';
  }

  private detectSticker(el: any): boolean {
    const w = el.attrs?.width ? Number(el.attrs.width) : 0;
    const h = el.attrs?.height ? Number(el.attrs.height) : 0;

    if (w > 0 && h > 0 && w <= 300 && h <= 300) {
      const ratio = Math.max(w, h) / Math.min(w, h);
      if (ratio < 1.5) return true;
    }

    const url = (el.attrs?.src || el.attrs?.url || '').toLowerCase();
    if (url.includes('marketface') || url.includes('sticker')) return true;

    return false;
  }

  handleRecall(
    recalledMsgId: string,
    recalledByName: string,
    buffer: MessageBuffer,
  ): NormalizedMessage | null {
    const original = buffer.findById(recalledMsgId);
    if (!original) return null;

    original.recalled = true;
    original.recalledAt = Date.now();

    const wasVisible = buffer.wasInRecentWindow(recalledMsgId);

    const preview = wasVisible ? this.getTextPreview(original, 30) : null;

    return {
      id: `recall-${recalledMsgId}`,
      sender: '系统',
      senderId: 'system',
      isBot: false,
      isSystemEvent: true,
      timestamp: Date.now(),
      segments: [{
        type: 'recall',
        recalledBy: recalledByName,
        originalPreview: preview,
      }],
      mentions: [],
    };
  }

  private getTextPreview(msg: NormalizedMessage, maxLen: number): string {
    const textParts = msg.segments
      .filter((s): s is import('./types').TextSegment => s.type === 'text')
      .map(s => s.content);
    const full = textParts.join('');
    return full.length > maxLen ? full.slice(0, maxLen) + '...' : full;
  }

  private buildPreviewFromSegments(segments: MessageSegment[]): string {
    const parts: string[] = [];
    for (const seg of segments) {
      switch (seg.type) {
        case 'text':    parts.push(seg.content); break;
        case 'face':    parts.push(`[${seg.name}]`); break;
        case 'image':   parts.push(seg.isSticker ? '[表情包]' : (seg.description ? `[图片：${seg.description}]` : '[图片]')); break;
        case 'share':   parts.push(`[分享：${seg.title}]`); break;
        case 'forward': parts.push(`[${seg.summary}]`); break;
        case 'poke':    parts.push(`[${seg.action}]`); break;
        case 'recall':  break; // system events don't belong in a quote preview
        case 'unsupported': if (seg.hint) parts.push(seg.hint); break;
      }
    }
    return parts.join('').trim();
  }

  private stripHtml(html: string): string {
    return html.replace(/<[^>]+>/g, '').trim();
  }
}

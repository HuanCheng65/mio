import { NormalizedMessage, MessageSegment, ImageSegment } from "./types";

export class ContextRenderer {
  constructor() {}

  /**
   * 将单条预处理消息渲染为供 LLM 阅读的纯文本格式
   */
  renderMessage(msg: NormalizedMessage, includePrefix: boolean = true): string {
    const time = new Date(msg.timestamp).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    });

    const content = this.renderContent(msg);
    if (!content) return "";

    if (msg.isSystemEvent) {
      return `〔系统 ${time}〕${content}`;
    }

    const selfPrefix = (includePrefix && msg.isBot) ? '[你之前说的] ' : '';
    const rolePrefix = msg.senderRole ? `【${msg.senderRole}】` : '';
    const titleSuffix = msg.senderTitle ? `【${msg.senderTitle}】` : '';

    const reactionSuffix = this.renderReactions(msg);
    return `${selfPrefix}${rolePrefix}${msg.sender}${titleSuffix}#${msg.senderId}(${time}): ${content}${reactionSuffix}`;
  }

  /**
   * 仅渲染内容（包括回复前缀和消息片段）
   */
  renderContent(msg: NormalizedMessage): string {
    const content = this.renderSegments(msg.segments);
    if (!content) return "";

    const replyPrefix = msg.replyTo
      ? `[回复 ${msg.replyTo.sender}: ${msg.replyTo.preview}] `
      : '';

    return `${replyPrefix}${content}`;
  }

  /**
   * 将消息列表渲染为 LLM 可读文本，含历史/新消息分区、recalled 过滤、reaction 追加。
   */
  render(messages: NormalizedMessage[], newMessageIds: Set<string>): { text: string; msgMap: Map<string, NormalizedMessage> } {
    const history: string[] = [];
    const fresh: string[] = [];
    const msgMap = new Map<string, NormalizedMessage>();
    let counter = 0;

    for (const msg of messages) {
      // 跳过已撤回的原始消息（保留撤回通知本身）
      if (msg.recalled && !msg.segments.some(s => s.type === 'recall')) {
        continue;
      }

      let line = this.renderMessage(msg);
      if (!line) continue;

      // 分配短 ID
      const shortId = `m${++counter}`;
      msgMap.set(shortId, msg);
      line = `[${shortId}] ${line}`;

      if (newMessageIds.has(msg.id)) {
        fresh.push(line);
      } else {
        history.push(line);
      }
    }

    const parts: string[] = [];
    if (history.length > 0) {
      parts.push(history.join('\n'));
    }
    if (fresh.length > 0) {
      parts.push('---\n【下面是刚刚发生的新消息】\n');
      parts.push(fresh.join('\n'));
    }

    return { text: parts.join('\n'), msgMap };
  }

  private renderReactions(msg: NormalizedMessage): string {
    if (!msg.reactions?.length) return '';

    const significant = msg.reactions.filter(r => r.count >= 1);
    if (significant.length === 0) return '';

    const summary = significant.map(r => `${r.emoji}×${r.count}`).join(' ');
    return ` [${summary}]`;
  }

  /**
   * 渲染片段列表
   */
  renderSegments(segments: MessageSegment[]): string {
    const parts: string[] = [];
    for (const seg of segments) {
      const rendered = this.renderSegment(seg);
      if (rendered) parts.push(rendered);
    }
    return parts.join('');
  }

  private renderSegment(seg: MessageSegment): string | null {
    switch (seg.type) {
      case 'text':
        return seg.content;

      case 'image':
        return this.renderImage(seg);

      case 'face':
        return `[${seg.name}]`;

      case 'share':
        return `[分享：${seg.title} ${seg.description || ''}]`;

      case 'forward':
        return `[${seg.summary}]`;

      case 'recall':
        if (seg.originalPreview) {
          return `[${seg.recalledBy} 撤回了一条消息（你看到了，说的是「${seg.originalPreview}」）]`;
        }
        return `[${seg.recalledBy} 撤回了一条消息]`;

      case 'poke':
        return `[${seg.action} ${seg.target}]`;

      case 'notice':
        return seg.content;

      case 'unsupported':
        return seg.hint;

      default:
        return null;
    }
  }

  private renderImage(seg: ImageSegment): string {
    if (seg.description) {
      if (seg.isSticker) {
        return `[表情包：${seg.description}]`;
      }
      return `[图片：${seg.description}]`;
    }
    return '[图片]';
  }
}

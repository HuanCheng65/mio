import { NormalizedMessage } from '../perception/types';

export class MessageBuffer {
  private buffers: Map<string, NormalizedMessage[]> = new Map();
  private maxSize: number;

  constructor(maxSize: number = 40) {
    this.maxSize = maxSize;
  }

  push(groupId: string, msg: NormalizedMessage): void {
    if (!this.buffers.has(groupId)) {
      this.buffers.set(groupId, []);
    }
    const buffer = this.buffers.get(groupId)!;
    buffer.push(msg);
    if (buffer.length > this.maxSize) {
      buffer.shift();
    }
  }

  getRecent(groupId: string, n?: number): NormalizedMessage[] {
    const buffer = this.buffers.get(groupId) || [];
    if (n === undefined) return [...buffer];
    return buffer.slice(-n);
  }

  getLastBotReply(groupId: string): NormalizedMessage | null {
    const buffer = this.buffers.get(groupId) || [];
    for (let i = buffer.length - 1; i >= 0; i--) {
      if (buffer[i].isBot) {
        return buffer[i];
      }
    }
    return null;
  }

  clear(groupId: string): void {
    this.buffers.delete(groupId);
  }

  findById(msgId: string): NormalizedMessage | undefined {
    for (const buf of this.buffers.values()) {
      const found = buf.find(m => m.id === msgId);
      if (found) return found;
    }
    return undefined;
  }

  wasInRecentWindow(msgId: string, windowSize: number = 30): boolean {
    for (const buf of this.buffers.values()) {
      const idx = buf.findIndex(m => m.id === msgId);
      if (idx >= 0 && idx >= buf.length - windowSize) return true;
    }
    return false;
  }

  handleReaction(
    msgId: string,
    emojiName: string,
    userId: string,
    isAdd: boolean,
    botId: string,
    totalCount?: number,
  ): void {
    const msg = this.findById(msgId);
    if (!msg) return;

    if (!msg.reactions) msg.reactions = [];

    let existing = msg.reactions.find(r => r.emoji === emojiName);
    if (isAdd) {
      if (!existing) {
        existing = { emoji: emojiName, count: 0, includesBot: false, reactors: [] };
        msg.reactions.push(existing);
      }
      existing.count = totalCount ?? existing.count + 1;
      if (!existing.reactors.includes(userId)) existing.reactors.push(userId);
      if (userId === botId) existing.includesBot = true;
    } else {
      if (existing) {
        existing.count = totalCount ?? Math.max(0, existing.count - 1);
        existing.reactors = existing.reactors.filter(id => id !== userId);
        if (userId === botId) existing.includesBot = false;
        if (existing.count === 0) {
          msg.reactions = msg.reactions.filter(r => r !== existing);
        }
      }
    }
  }

  markRecalled(msgId: string): void {
    const msg = this.findById(msgId);
    if (msg) {
      msg.recalled = true;
    }
  }
}

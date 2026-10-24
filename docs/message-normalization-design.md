# 消息标准化系统设计

> **目标**：将 QQ 群聊中所有类型的消息，统一转化为 LLM 能自然理解的文本表示。
> 模拟一个真人「扫一眼群聊」后脑子里留下的印象。

---

## 1. 架构总览

```
QQ 原始消息 (Koishi Session)
    │
    ▼
┌──────────────────────────────┐
│     MessageNormalizer        │  ← 负责将 Koishi elements 转为统一结构
│  - 逐 element 解析          │
│  - 异步处理（图片/语音）     │
│  - 撤回消息判断              │
└──────────────┬───────────────┘
               │
               ▼
       NormalizedMessage        ← 内部统一数据结构
               │
               ▼
┌──────────────────────────────┐
│       MessageBuffer          │  ← 存储，管理窗口和过期
│  - 存 NormalizedMessage      │
│  - 按群维护环形缓冲          │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│      ContextRenderer         │  ← 渲染为 LLM 可读文本
│  - 历史消息 / 新消息分区     │
│  - 控制详略（旧消息可压缩）  │
└──────────────────────────────┘
               │
               ▼
         LLM prompt 中的消息流文本
```

**关键分离**：Normalizer 只管"结构化"，Renderer 只管"渲染为文本"。
两者之间用 `NormalizedMessage` 接口连接，互不关心对方的实现。

---

## 2. 数据结构

### 2.1 NormalizedMessage

```typescript
interface NormalizedMessage {
  id: string;                    // 消息 ID（用于撤回追踪、reaction 关联）
  sender: string;                // 显示名（群名片 > 昵称 > ID）
  senderId: string;              // QQ号 / user_id
  isBot: boolean;                // 是否是澪自己发的
  timestamp: number;

  // 核心内容
  segments: MessageSegment[];

  // 结构信息
  replyTo?: ReplyInfo;           // 引用回复
  mentions: MentionInfo[];       // 所有 @

  // 后续可追加的元信息
  reactions?: ReactionInfo[];    // 消息的 reaction（异步更新）
  recalled?: boolean;            // 是否已被撤回
  recalledAt?: number;           // 撤回时间
}
```

### 2.2 MessageSegment（消息片段联合类型）

一条 QQ 消息可以包含多个片段（比如"文字+图片+文字"），用数组表示：

```typescript
type MessageSegment =
  | TextSegment
  | ImageSegment
  | VoiceSegment
  | FaceSegment
  | ShareSegment
  | ForwardSegment
  | RecallNotice
  | PokeSegment
  | UnsupportedSegment;

// ── 文本 ──
interface TextSegment {
  type: 'text';
  content: string;
}

// ── 图片 ──
interface ImageSegment {
  type: 'image';
  url: string;                         // 原始 URL（用于下载/缓存 key）
  description: string | null;          // LLM 理解结果，null = 尚未处理
  isSticker: boolean;                  // 是否是表情包（影响渲染措辞）
  width?: number;
  height?: number;
}

// ── 语音 ──
interface VoiceSegment {
  type: 'voice';
  transcription: string | null;        // STT 结果，null = 尚未处理
  durationSec: number;
  url: string;
}

// ── QQ 系统表情 ──
interface FaceSegment {
  type: 'face';
  faceId: number;                      // QQ 表情 ID
  name: string;                        // 可读名称："呲牙" / "流泪" / "偷笑"
}

// ── 商城表情（大表情） ──
// 归入 image，isSticker = true

// ── 分享卡片（链接/音乐/视频/小程序） ──
interface ShareSegment {
  type: 'share';
  subtype: 'link' | 'music' | 'video' | 'miniapp' | 'unknown';
  title: string;
  description?: string;                // 摘要/副标题
  platform?: string;                   // "网易云音乐" / "B站" / "bilibili"
  url?: string;                        // 原始链接（不注入 LLM，仅内部用）
}

// ── 合并转发 ──
interface ForwardSegment {
  type: 'forward';
  summary: string;                     // "A 和 B 的聊天记录（共 12 条）"
  // 真人一般懒得点开。不做深度展开。
}

// ── 撤回通知（不是 segment，但统一处理） ──
interface RecallNotice {
  type: 'recall';
  recalledBy: string;                  // 谁撤回的
  originalPreview: string | null;      // 如果澪"看到过"原消息，放摘要
}

// ── 戳一戳 ──
interface PokeSegment {
  type: 'poke';
  target: string;                      // 被戳的人
  action: string;                      // "戳了戳" / "拍了拍"
}

// ── 兜底 ──
interface UnsupportedSegment {
  type: 'unsupported';
  hint: string;                        // "[不支持的消息类型]" / "[文件: xxx.pdf]"
}
```

### 2.3 引用和 @

```typescript
interface ReplyInfo {
  messageId: string;                   // 被引用的消息 ID
  sender: string;                      // 被引用消息的发送者显示名
  preview: string;                     // 摘要，≤40字，超出截断加 "..."
}

interface MentionInfo {
  userId: string;
  displayName: string;
  isBot: boolean;                      // 是否 @ 了澪
}

interface ReactionInfo {
  emoji: string;                       // "👍" / QQ 表情名
  count: number;
  includesBot: boolean;                // 澪是否 react 过
  reactors: string[];                  // user_id 列表（可选，可能拿不到）
}
```

---

## 3. MessageNormalizer

### 3.1 主入口

```typescript
class MessageNormalizer {
  constructor(
    private imageProcessor: ImageProcessor,
    private voiceProcessor: VoiceProcessor | null,
    private faceMap: QQFaceMap,
    private botId: string,
    private botName: string,
  ) {}

  /**
   * 将 Koishi Session 转为 NormalizedMessage。
   * 图片理解和语音转写是异步的，返回时可能 description/transcription 还是 null。
   * 调用方需要自行处理异步完成后的回填。
   */
  async normalize(session: Session): Promise<NormalizedMessage> {
    const segments: MessageSegment[] = [];
    const mentions: MentionInfo[] = [];

    // 1. 处理 elements
    for (const el of session.elements ?? []) {
      const result = await this.normalizeElement(el, session);
      if (result.segment) segments.push(result.segment);
      if (result.mention) mentions.push(result.mention);
    }

    // 2. 如果 elements 为空，fallback 到 session.content 纯文本
    if (segments.length === 0 && session.content) {
      segments.push({
        type: 'text',
        content: this.stripHtml(session.content),
      });
    }

    // 3. 处理引用
    const replyTo = this.extractReply(session);

    // 4. 组装
    return {
      id: session.messageId ?? session.event?.message?.id ?? crypto.randomUUID(),
      sender: this.resolveSenderName(session),
      senderId: session.userId,
      isBot: session.userId === this.botId,
      timestamp: session.timestamp ?? Date.now(),
      segments,
      replyTo,
      mentions,
    };
  }
```

### 3.2 逐 Element 处理

```typescript
  private async normalizeElement(
    el: Element,
    session: Session,
  ): Promise<{ segment?: MessageSegment; mention?: MentionInfo }> {
    switch (el.type) {
      // ── 文本 ──
      case 'text': {
        const content = el.attrs?.content ?? '';
        if (!content.trim()) return {};
        return { segment: { type: 'text', content } };
      }

      // ── @ ──
      case 'at': {
        const targetId = el.attrs?.id;
        const isBot = targetId === this.botId;
        const displayName = isBot
          ? this.botName
          : await this.resolveUserName(el, session);

        return {
          // @ 不产生 segment，而是作为 mention 记录 + 内嵌在文本中
          // 实际上 Koishi 的 elements 中 at 和 text 是分开的，
          // 我们在后处理阶段把 at 合并到相邻 text 中
          segment: { type: 'text', content: `@${displayName}` },
          mention: { userId: targetId, displayName, isBot },
        };
      }

      // ── 图片 ──
      case 'img':
      case 'image': {
        const url = el.attrs?.src || el.attrs?.url;
        if (!url) return { segment: { type: 'unsupported', hint: '[图片:无法获取]' } };

        // 判断是否是表情包（启发式：正方形、文件小、或特殊路径标记）
        const isSticker = this.detectSticker(el);

        // 先看缓存
        const cached = this.imageProcessor.getCachedSync(url);

        // 不管有没有缓存，都创建 segment
        const segment: ImageSegment = {
          type: 'image',
          url,
          description: cached ?? null,    // 有缓存就用，没有先 null
          isSticker,
          width: el.attrs?.width,
          height: el.attrs?.height,
        };

        // 如果没缓存，触发异步理解（不阻塞）
        if (!cached) {
          this.imageProcessor.processAsync(url, isSticker).then(desc => {
            segment.description = desc;
            // 同时写入缓存
          });
        }

        return { segment };
      }

      // ── 语音 ──
      case 'audio':
      case 'record': {
        const url = el.attrs?.src || el.attrs?.url;
        const duration = el.attrs?.duration ?? 0;
        const segment: VoiceSegment = {
          type: 'voice',
          url: url ?? '',
          transcription: null,
          durationSec: Math.round(duration / 1000),  // Koishi 可能给 ms
        };

        // 异步 STT
        if (url && this.voiceProcessor) {
          this.voiceProcessor.transcribe(url).then(text => {
            segment.transcription = text;
          });
        }

        return { segment };
      }

      // ── QQ 系统表情 ──
      case 'face': {
        const faceId = el.attrs?.id;
        const name = this.faceMap.getName(faceId) ?? `表情${faceId}`;
        return { segment: { type: 'face', faceId, name } };
      }

      // ── 分享卡片 / JSON 消息 ──
      case 'json':
      case 'share': {
        return { segment: this.parseShareCard(el) };
      }

      // ── 合并转发 ──
      case 'forward': {
        const count = el.attrs?.count ?? '?';
        return {
          segment: {
            type: 'forward',
            summary: `聊天记录（${count}条）`,
          },
        };
      }

      // ── 戳一戳 ──
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

      // ── 文件 ──
      case 'file': {
        const name = el.attrs?.name || '未知文件';
        return { segment: { type: 'unsupported', hint: `[文件: ${name}]` } };
      }

      // ── 视频 ──
      case 'video': {
        return { segment: { type: 'unsupported', hint: '[视频]' } };
      }

      // ── 兜底 ──
      default: {
        return { segment: { type: 'unsupported', hint: `[${el.type}]` } };
      }
    }
  }
```

### 3.3 引用消息处理

```typescript
  private extractReply(session: Session): ReplyInfo | undefined {
    const quote = session.quote || session.event?.message?.quote;
    if (!quote) return undefined;

    // 提取被引用消息的纯文本摘要
    let rawText = quote.content?.replace(/<[^>]+>/g, '').trim() || '';
    const preview = rawText.length > 40
      ? rawText.slice(0, 40) + '...'
      : rawText;

    return {
      messageId: quote.id ?? '',
      sender: quote.user?.name || quote.member?.nick || '某人',
      preview,
    };
  }
```

### 3.4 分享卡片解析

QQ 的分享卡片底层是 JSON，结构复杂且版本多变。核心策略：**尽力提取标题和来源，提取不到就标注为未知。**

```typescript
  private parseShareCard(el: Element): ShareSegment {
    // Koishi share element
    if (el.type === 'share') {
      return {
        type: 'share',
        subtype: 'link',
        title: el.attrs?.title || '链接',
        description: el.attrs?.content,
        url: el.attrs?.url,
      };
    }

    // JSON 卡片（小程序、音乐、视频等）
    try {
      const data = JSON.parse(el.attrs?.data || '{}');

      // QQ JSON 卡片常见结构
      const meta = data.meta || {};
      const detail = meta.detail_1 || meta.music || meta.news || {};
      const app = data.app || '';

      // 判断子类型
      let subtype: ShareSegment['subtype'] = 'unknown';
      if (app.includes('music') || meta.music) subtype = 'music';
      else if (app.includes('video') || app.includes('bilibili')) subtype = 'video';
      else if (app.includes('miniapp') || data.view === 'miniapp') subtype = 'miniapp';
      else if (detail.title || data.prompt) subtype = 'link';

      // 提取平台
      const platform = this.detectPlatform(app, data.prompt, detail);

      return {
        type: 'share',
        subtype,
        title: detail.title || data.prompt || '卡片消息',
        description: detail.desc || detail.preview,
        platform,
        url: detail.qqdocurl || detail.jumpUrl,
      };
    } catch {
      return {
        type: 'share',
        subtype: 'unknown',
        title: el.attrs?.data?.slice(0, 30) || '卡片消息',
      };
    }
  }

  private detectPlatform(app: string, prompt: string, detail: any): string | undefined {
    const text = `${app} ${prompt} ${detail?.title ?? ''}`.toLowerCase();
    if (text.includes('163') || text.includes('netease') || text.includes('网易云')) return '网易云音乐';
    if (text.includes('qq音乐') || text.includes('qqmusic')) return 'QQ音乐';
    if (text.includes('bilibili') || text.includes('b站') || text.includes('哔哩')) return 'B站';
    if (text.includes('douyin') || text.includes('抖音')) return '抖音';
    if (text.includes('spotify')) return 'Spotify';
    return undefined;
  }
```

### 3.5 撤回消息处理

撤回不是一个 element，而是一个事件（Koishi 的 `message-deleted`）。需要在消息缓冲中标记：

```typescript
class MessageNormalizer {
  // ...

  /**
   * 处理撤回事件。在 MessageBuffer 中标记对应消息为已撤回，
   * 并返回一条「撤回通知」用于注入到消息流中。
   */
  handleRecall(
    recalledMsgId: string,
    operatorId: string,
    buffer: MessageBuffer,
  ): NormalizedMessage | null {
    const original = buffer.findById(recalledMsgId);
    if (!original) return null;

    // 标记原消息为已撤回
    original.recalled = true;
    original.recalledAt = Date.now();

    // 判断澪是否"看到过"这条消息
    // 规则：如果消息在最近 N 条内（即 LLM 上次 context 中包含的范围），
    //        认为澪看到了
    const wasVisible = buffer.wasInRecentWindow(recalledMsgId);
    const senderName = original.sender;

    const preview = wasVisible
      ? this.getTextPreview(original, 30)   // 截取前30字作为摘要
      : null;

    // 生成一条「撤回通知消息」插入消息流
    return {
      id: `recall-${recalledMsgId}`,
      sender: '系统',
      senderId: 'system',
      isBot: false,
      timestamp: Date.now(),
      segments: [{
        type: 'recall',
        recalledBy: senderName,
        originalPreview: preview,
      }],
      mentions: [],
    };
  }

  private getTextPreview(msg: NormalizedMessage, maxLen: number): string {
    const textParts = msg.segments
      .filter(s => s.type === 'text')
      .map(s => (s as TextSegment).content);
    const full = textParts.join('');
    return full.length > maxLen ? full.slice(0, maxLen) + '...' : full;
  }
}
```

### 3.6 辅助方法

```typescript
  // 发送者名称解析：群名片 > 昵称 > ID
  private resolveSenderName(session: Session): string {
    return session.event?.member?.nick
      || session.author?.nick
      || session.author?.name
      || session.username
      || session.userId;
  }

  // 解析 @目标 的名称
  private async resolveUserName(el: Element, session: Session): Promise<string> {
    const targetId = el.attrs?.id;
    let name = el.attrs?.name;

    if (!name && targetId && session.guildId) {
      try {
        const member = await session.bot.getGuildMember(session.guildId, targetId);
        name = member?.nick || member?.user?.nick || member?.user?.name;
      } catch { /* 获取失败用 ID */ }
    }

    return name || targetId || '未知';
  }

  // 检测是否是表情包（启发式）
  private detectSticker(el: Element): boolean {
    const w = el.attrs?.width ?? 0;
    const h = el.attrs?.height ?? 0;

    // 小尺寸 + 接近正方形 → 大概率表情包
    if (w > 0 && h > 0 && w <= 300 && h <= 300) {
      const ratio = Math.max(w, h) / Math.min(w, h);
      if (ratio < 1.5) return true;
    }

    // 某些 NapCat 特征路径可辅助判断
    const url = (el.attrs?.src || el.attrs?.url || '').toLowerCase();
    if (url.includes('marketface') || url.includes('sticker')) return true;

    return false;
  }

  private stripHtml(html: string): string {
    return html.replace(/<[^>]+>/g, '').trim();
  }
```

---

## 4. QQ 系统表情映射

QQ 有大约 200+ 个系统表情，每个有固定 ID。需要一个映射表。

```typescript
class QQFaceMap {
  // 核心映射表（只列最常用的，完整版单独维护）
  private static readonly MAP: Record<number, string> = {
    0: '惊讶', 1: '撇嘴', 2: '色', 4: '得意', 5: '流泪',
    6: '害羞', 7: '闭嘴', 8: '睡', 9: '大哭', 10: '尴尬',
    11: '发怒', 12: '调皮', 13: '呲牙', 14: '微笑', 15: '难过',
    16: '酷', 18: '抓狂', 19: '吐', 20: '偷笑', 21: '可爱',
    22: '白眼', 23: '傲慢', 24: '饥饿', 25: '困', 26: '惊恐',
    27: '流汗', 28: '憨笑', 29: '悠闲', 30: '奋斗', 31: '咒骂',
    32: '疑问', 33: '嘘', 34: '晕', 35: '折磨', 36: '衰',
    37: '骷髅', 38: '敲打', 39: '再见', 46: '猪头',
    49: '拥抱', 53: '蛋糕', 55: '炸弹', 59: '便便',
    60: '咖啡', 63: '玫瑰', 64: '凋谢', 66: '爱心',
    67: '心碎', 74: '太阳', 75: '月亮', 76: '赞',
    77: '踩', 78: '握手', 79: '胜利', 85: '飞吻',
    86: '怄火', 89: '西瓜', 96: '冷汗', 97: '擦汗',
    98: '抠鼻', 99: '鼓掌', 100: '糗大了', 101: '坏笑',
    102: '左哼哼', 103: '右哼哼', 104: '哈欠', 105: '鄙视',
    106: '委屈', 107: '快哭了', 108: '阴险', 109: '亲亲',
    110: '吓', 111: '可怜', 112: '菜刀', 114: '篮球',
    116: '示爱', 118: '抱拳', 120: '拳头', 122: '爱你',
    123: 'NO', 124: 'OK', 125: '转圈', 129: '挥手',
    144: '微笑', 145: '生病', 146: '破涕为笑', 147: '吃瓜',
    171: '点赞', 173: '託脸', 174: '加油必胜', 175: '加油抱抱',
    176: '无语', 177: '酱', 178: '汪汪', 179: '汗', 180: '打脸',
    181: '击掌', 182: '无语', 183: '敬礼', 187: '翻白眼',
    // ... 可从 NapCat/go-cqhttp 的表情列表补全
  };

  getName(faceId: number): string | undefined {
    return QQFaceMap.MAP[faceId];
  }
}
```

> **维护策略**：不需要覆盖所有表情。未映射的用 `[表情]` 兜底。
> 真人也不会认识每一个 QQ 表情。

---

## 5. 语音处理

```typescript
interface VoiceProcessor {
  /**
   * 将语音 URL 转为文字。
   * NapCat 提供的语音 URL 通常是 silk 格式，需要先转码。
   */
  transcribe(url: string): Promise<string>;
}

class WhisperVoiceProcessor implements VoiceProcessor {
  constructor(
    private whisperEndpoint: string,  // Whisper API 或本地 whisper server
    private tempDir: string,
  ) {}

  async transcribe(url: string): Promise<string> {
    // 1. 下载语音文件
    const audioBuffer = await this.download(url);

    // 2. silk → wav/mp3 转码
    //    NapCat 通常已经做了转码，如果还是 silk 需要用 silk-decoder
    const wavBuffer = await this.convertIfNeeded(audioBuffer);

    // 3. STT
    const result = await this.callWhisper(wavBuffer);
    return result.text;
  }
}
```

> **成本考量**：群聊语音一般 5-30 秒，STT 成本极低。
> 如果担心频率，可以做简单的限流：每分钟最多处理 N 条语音。
>
> **降级策略**：如果 STT 不可用或失败，fallback 到 `[语音 Xs]`（不含转写）。

---

## 6. ContextRenderer — 渲染为 LLM 可读文本

这是最关键的模块。它决定了 LLM "看到"什么。

### 6.1 核心逻辑

```typescript
class ContextRenderer {
  constructor(
    private botName: string,
    private botId: string,
  ) {}

  /**
   * 将消息列表渲染为 LLM 可读文本。
   * @param messages 所有消息（已排序）
   * @param newMessageIds 标记哪些是「新消息」（debounce 窗口内的）
   */
  render(messages: NormalizedMessage[], newMessageIds: Set<string>): string {
    const history: string[] = [];
    const fresh: string[] = [];

    for (const msg of messages) {
      // 跳过已撤回的消息（但保留撤回通知本身）
      if (msg.recalled && !msg.segments.some(s => s.type === 'recall')) {
        continue;
      }

      const line = this.renderMessage(msg);
      if (!line) continue;

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

    return parts.join('\n');
  }

  private renderMessage(msg: NormalizedMessage): string | null {
    const time = new Date(msg.timestamp).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    });

    // 渲染所有 segments
    const content = this.renderSegments(msg.segments);
    if (!content) return null;

    // 引用前缀
    const replyPrefix = msg.replyTo
      ? `[回复 ${msg.replyTo.sender}: ${msg.replyTo.preview}] `
      : '';

    // 澪自己的消息特殊标记
    const selfPrefix = msg.isBot ? '[你之前说的] ' : '';

    // 最终格式：
    // [14:32] A: 今天食堂的糖醋排骨绝了
    // [14:33] [你之前说的] 澪: 确实不错
    // [14:35] B: [回复 A: 今天食堂的糖醋排骨绝了] 哪个食堂
    return `${selfPrefix}${msg.sender}(${time}): ${replyPrefix}${content}`;
  }
```

### 6.2 Segment 渲染规则

```typescript
  private renderSegments(segments: MessageSegment[]): string | null {
    const parts: string[] = [];

    for (const seg of segments) {
      const rendered = this.renderSegment(seg);
      if (rendered) parts.push(rendered);
    }

    return parts.length > 0 ? parts.join(' ') : null;
  }

  private renderSegment(seg: MessageSegment): string | null {
    switch (seg.type) {
      case 'text':
        return seg.content;

      case 'image':
        return this.renderImage(seg);

      case 'voice':
        return this.renderVoice(seg);

      case 'face':
        return `[${seg.name}]`;

      case 'share':
        return this.renderShare(seg);

      case 'forward':
        return `[${seg.summary}]`;

      case 'recall':
        return this.renderRecall(seg);

      case 'poke':
        return `[${seg.action} ${seg.target}]`;

      case 'unsupported':
        return seg.hint;

      default:
        return null;
    }
  }

  // ── 图片渲染 ──
  private renderImage(seg: ImageSegment): string {
    if (seg.description) {
      // 有理解结果
      if (seg.isSticker) {
        return `[表情包：（看起来像是）${seg.description}]`;
      }
      return `[图片：（看起来像是）${seg.description}]`;
    }

    // 没有理解结果（异步还没完成、或处理失败）
    if (seg.isSticker) return '[表情包]';
    return '[图片]';
  }

  // ── 语音渲染 ──
  private renderVoice(seg: VoiceSegment): string {
    if (seg.transcription) {
      return `[语音 ${seg.durationSec}s: "${seg.transcription}"]`;
    }
    return `[语音 ${seg.durationSec}s]`;
  }

  // ── 分享卡片渲染 ──
  private renderShare(seg: ShareSegment): string {
    const parts: string[] = [];

    // 子类型前缀
    const typeLabel: Record<string, string> = {
      music: '音乐分享',
      video: '视频分享',
      miniapp: '小程序',
      link: '链接',
      unknown: '分享',
    };
    let label = typeLabel[seg.subtype] || '分享';

    // 平台
    if (seg.platform) {
      label = `${seg.platform}`;
    }

    // 标题
    parts.push(`[${label}: ${seg.title}]`);

    return parts.join('');
  }

  // ── 撤回渲染 ──
  private renderRecall(seg: RecallNotice): string {
    if (seg.originalPreview) {
      return `[${seg.recalledBy} 撤回了一条消息（你看到了，说的是「${seg.originalPreview}」）]`;
    }
    return `[${seg.recalledBy} 撤回了一条消息]`;
  }
}
```

### 6.3 渲染示例：最终 LLM 看到的文本

```
A(14:32): 今天食堂的糖醋排骨绝了
A(14:32): [图片：一盘红棕色的糖醋排骨，看起来很有食欲]
B(14:33): 哪个食堂
A(14:33): 二食堂
C(14:35): [网易云音乐: 花の塔 - さユり]
C(14:35): 这首歌好好听
D(14:36): [语音 8s: "确实不错 我循环好几天了"]
E(14:40): @澪 你听过这首吗
[B 撤回了一条消息]
[你之前说的] 澪(14:41): 听过，很好听
F(14:42): [表情包：一个猫猫摇头的动图]
G(14:43): [戳了戳 澪]

---
【下面是刚刚发生的新消息】

H(14:45): 有人要打 apex 吗
A(14:45): [回复 H: 有人要打 apex 吗] 来
I(14:46): [回复 H: 有人要打 apex 吗] 我也来
```

---

## 7. Reaction 处理

> QQ 的 reaction（消息表态/回应）是一个相对新的功能。

### 7.1 感知侧

Reaction 事件到来时，更新对应 `NormalizedMessage` 的 `reactions` 字段：

```typescript
class MessageBuffer {
  handleReaction(msgId: string, emoji: string, userId: string, isAdd: boolean): void {
    const msg = this.findById(msgId);
    if (!msg) return;

    if (!msg.reactions) msg.reactions = [];

    let existing = msg.reactions.find(r => r.emoji === emoji);
    if (isAdd) {
      if (!existing) {
        existing = { emoji, count: 0, includesBot: false, reactors: [] };
        msg.reactions.push(existing);
      }
      existing.count++;
      existing.reactors.push(userId);
      if (userId === this.botId) existing.includesBot = true;
    } else {
      if (existing) {
        existing.count = Math.max(0, existing.count - 1);
        existing.reactors = existing.reactors.filter(id => id !== userId);
        if (userId === this.botId) existing.includesBot = false;
      }
    }
  }
}
```

### 7.2 渲染

Reaction 信息量低，大部分时候不需要注入 LLM。

**只在以下情况渲染 reaction**：
- 澪自己的消息被 reaction 了（你说了一句话，有人给你点了赞/点了个表情）
- 短时间内某条消息收到大量 reaction（群里有什么"爆点"）

```typescript
  // 在 renderMessage 中追加
  private renderReactions(msg: NormalizedMessage): string {
    if (!msg.reactions?.length) return '';

    // 只渲染有意义的 reaction
    const significant = msg.reactions.filter(r =>
      r.count >= 3 ||                          // 3+ 人 react 了同一个
      (msg.isBot && r.count >= 1)              // 澪的消息被 react 了
    );

    if (significant.length === 0) return '';

    const summary = significant
      .map(r => `${r.emoji}×${r.count}`)
      .join(' ');

    return ` [${summary}]`;
  }
```

效果：
```
[你之前说的] 澪(14:41): 听过，很好听 [👍×3]
```

---

## 8. 异步处理的时序问题

图片理解和语音转写都是异步的。消息到达时可能还没处理完。

### 8.1 问题

```
t=0    消息到达，包含图片
t=50ms Normalizer 创建 NormalizedMessage，description=null
t=200ms Debouncer 触发，ContextRenderer 渲染 → 图片显示为 [图片]
t=800ms 图片理解完成，description 回填
       但 LLM 已经看到 [图片] 了，不知道图片内容
```

### 8.2 解决策略

分两种情况：

**情况 A：图片理解比 debounce 窗口快（大部分情况）**

Debounce 窗口通常 3-8 秒。如果图片理解在此期间完成，渲染时自然能拿到 description。
这依赖于图片缓存命中率——已缓存的图片是瞬时的。

**情况 B：图片理解比 debounce 窗口慢**

两个选项：
1. **等一等**：在 ContextRenderer.render() 之前，给未完成的图片一个短暂的宽限期（比如 2 秒）
2. **不等**：直接渲染为 `[图片]`，下次消息到来时如果理解完成了，就有了

推荐选项 1，实现简单：

```typescript
class ContextRenderer {
  async renderWithWait(
    messages: NormalizedMessage[],
    newMessageIds: Set<string>,
    maxWaitMs: number = 2000,     // 最多等 2 秒
  ): Promise<string> {
    // 收集所有未完成的图片/语音
    const pending = this.collectPendingAsync(messages);

    if (pending.length > 0) {
      // 等待它们完成，但最多等 maxWaitMs
      await Promise.race([
        Promise.all(pending),
        sleep(maxWaitMs),
      ]);
    }

    return this.render(messages, newMessageIds);
  }

  private collectPendingAsync(messages: NormalizedMessage[]): Promise<void>[] {
    const promises: Promise<void>[] = [];
    for (const msg of messages) {
      for (const seg of msg.segments) {
        if (seg.type === 'image' && seg.description === null) {
          // imageProcessor 内部可以暴露一个 waitFor(url) 的 Promise
          promises.push(this.imageProcessor.waitForProcessing(seg.url));
        }
        if (seg.type === 'voice' && seg.transcription === null) {
          promises.push(this.voiceProcessor.waitForTranscription(seg.url));
        }
      }
    }
    return promises;
  }
}
```

这样大部分时候图片理解都能赶上渲染。极端情况下（网络慢、图片大），退化为 `[图片]` 也是可以接受的——真人也不一定每张图都看清楚了。

---

## 9. MessageBuffer 改造

现有的 MessageBuffer 需要从存 string 改为存 `NormalizedMessage`：

```typescript
class MessageBuffer {
  private buffers: Map<string, NormalizedMessage[]> = new Map();
  private maxSize: number;  // 每个群的缓冲大小

  constructor(maxSize: number = 100) {
    this.maxSize = maxSize;
  }

  push(groupId: string, msg: NormalizedMessage): void {
    let buf = this.buffers.get(groupId);
    if (!buf) {
      buf = [];
      this.buffers.set(groupId, buf);
    }
    buf.push(msg);
    if (buf.length > this.maxSize) {
      buf.shift();  // 环形缓冲
    }
  }

  findById(msgId: string): NormalizedMessage | undefined {
    for (const buf of this.buffers.values()) {
      const found = buf.find(m => m.id === msgId);
      if (found) return found;
    }
    return undefined;
  }

  /**
   * 判断某条消息是否在"澪最近看到"的窗口内。
   * 用于撤回时判断澪是否"看到过"原消息。
   */
  wasInRecentWindow(msgId: string, windowSize: number = 30): boolean {
    for (const buf of this.buffers.values()) {
      const idx = buf.findIndex(m => m.id === msgId);
      if (idx >= 0 && idx >= buf.length - windowSize) return true;
    }
    return false;
  }

  /**
   * 获取用于渲染的消息列表。
   * @param count 取最近 N 条
   */
  getRecent(groupId: string, count: number): NormalizedMessage[] {
    const buf = this.buffers.get(groupId) || [];
    return buf.slice(-count);
  }

  /**
   * 格式化输出（调用 ContextRenderer）
   */
  format(groupId: string, renderer: ContextRenderer, newMessageIds: Set<string>): string {
    const messages = this.getRecent(groupId, 50);  // 取最近 50 条
    return renderer.render(messages, newMessageIds);
  }
}
```

---

## 10. 与现有系统的集成

### 10.1 消息入口改造

现有的 `extractTextWithMentions` 被 `MessageNormalizer.normalize()` 替代。

```typescript
// 旧：
// const text = await extractTextWithMentions(session, config, buffer, imageProc);
// buffer.push(groupId, { content: text, ... });

// 新：
const normalizedMsg = await normalizer.normalize(session);
buffer.push(groupId, normalizedMsg);
```

### 10.2 撤回事件监听

```typescript
// Koishi 中监听撤回事件
ctx.on('message-deleted', (session) => {
  const recalledMsgId = session.messageId;
  const operatorId = session.userId;  // 撤回者
  const groupId = session.guildId;

  const notice = normalizer.handleRecall(recalledMsgId, operatorId, buffer);
  if (notice) {
    buffer.push(groupId, notice);
  }
});
```

### 10.3 Reaction 事件监听

```typescript
// NapCat 的 reaction 事件（具体事件名取决于 NapCat 版本）
ctx.on('reaction-added', (session) => {
  buffer.handleReaction(
    session.messageId,
    session.emoji,
    session.userId,
    true,   // isAdd
  );
});

ctx.on('reaction-removed', (session) => {
  buffer.handleReaction(
    session.messageId,
    session.emoji,
    session.userId,
    false,  // isAdd
  );
});
```

### 10.4 主流程调用

```typescript
// 在准备 LLM 调用时
const renderer = new ContextRenderer(config.botName, config.botId);
const messageText = await renderer.renderWithWait(
  buffer.getRecent(groupId, 50),
  newMessageIds,
);

// messageText 直接注入到 Layer 4 对话部分
```

---

## 11. 边界情况与降级

| 场景 | 处理 |
|------|------|
| 图片 URL 过期 / 下载失败 | 渲染为 `[图片]`，日志记录 |
| 语音转写失败 | 渲染为 `[语音 Xs]`（无转写） |
| JSON 卡片解析失败 | 渲染为 `[卡片消息]` |
| 合并转发 | 只显示摘要，不展开内容 |
| NapCat 不支持的事件 | `UnsupportedSegment` 兜底 |
| 消息元素为空 | 尝试 fallback 到 session.content |
| 超大图片（>5MB） | 正常处理，imageProcessor 内部处理压缩 |
| 表情 ID 未映射 | 渲染为 `[表情]` |
| Reaction 事件平台不支持 | 静默忽略 |

import { Session } from 'koishi';
import { passiveReplyBlocker, recordPassiveReply } from '../platform/qq';

/**
 * 计算两个字符串的编辑距离（Levenshtein）
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

export interface DeliveryOptions {
  minDelay?: number;
  maxDelay?: number;
  splitThreshold?: number;
  typingSpeed?: number;
}

const defaultOptions: Required<DeliveryOptions> = {
  minDelay: 2000,
  maxDelay: 6000,
  splitThreshold: 40,
  typingSpeed: 100,
};

function splitMessage(content: string, threshold: number): string[] {
  // 先按换行符拆分
  const lines = content.split('\n').filter(line => line.trim());

  // 如果有多行，直接返回（换行就是想分开发送）
  if (lines.length > 1) {
    return lines;
  }

  // 单行内容，检查是否需要按长度拆分
  const singleLine = lines[0];
  if (singleLine.length <= threshold) {
    return [singleLine];
  }

  // 按标点符号拆分，但保留标点符号和前面的内容
  const parts: string[] = [];
  let current = '';

  // 匹配句子：非标点字符 + 标点符号
  const sentenceRegex = /[^。！？\n]+[。！？]?/g;
  const sentences = singleLine.match(sentenceRegex) || [singleLine];

  for (const sentence of sentences) {
    // 如果当前累积 + 新句子不超过阈值，就累积
    if (current.length + sentence.length <= threshold) {
      current += sentence;
    } else {
      // 超过阈值了
      if (current) {
        parts.push(current.trim());
        current = sentence;
      } else {
        // current 为空说明单个句子就超长了，直接放进去
        parts.push(sentence.trim());
      }
    }
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts.length > 0 ? parts : [singleLine];
}

function calculateDelay(length: number, options: Required<DeliveryOptions>): number {
  const baseDelay = Math.min(
    options.maxDelay,
    Math.max(options.minDelay, length * options.typingSpeed)
  );
  const jitter = Math.random() * 1000;
  return baseDelay + jitter;
}

/**
 * 拆分后逐条发送。每条发送前检查平台的被动回复限制，不满足就停下，
 * 返回已发出的片段、平台消息 ID 和停下的原因（全部发出时 blocked 为 null）。
 */
export async function humanizedSend(
  session: Session,
  content: string,
  options?: DeliveryOptions
): Promise<{ sentParts: string[]; messageIds: string[]; blocked: string | null }> {
  const opts = { ...defaultOptions, ...options };

  // 拆分消息
  const parts = splitMessage(content, opts.splitThreshold);
  const sentParts: string[] = [];
  const messageIds: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim().replace(/。$/, '');
    if (!part) continue;

    // 计算延迟
    const delay = i === 0 ? calculateDelay(part.length, opts) : Math.random() * 2000 + 1000;

    await new Promise((resolve) => setTimeout(resolve, delay));
    const blocked = passiveReplyBlocker(session);
    if (blocked) return { sentParts, messageIds, blocked };
    messageIds.push(...(await session.send(part)));
    recordPassiveReply(session);
    sentParts.push(part);
  }

  return { sentParts, messageIds, blocked: null };
}

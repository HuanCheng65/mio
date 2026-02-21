import { Session } from 'koishi';

export interface UserInfo {
  name: string;
  id: string;
}

/**
 * 计算两个字符串的编辑距离（Levenshtein）
 */
function levenshtein(a: string, b: string): number {
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

/**
 * 去掉【...】称号/身份部分，返回纯名字
 */
function stripTitle(name: string): string {
  return name.replace(/【[^】]*】/g, '').trim();
}

/**
 * 将 message 中形如 @Xxx（非 @#数字 格式）的提及，
 * 通过模糊匹配替换为 @#ID 格式。
 *
 * @param message  LLM 原始输出文本
 * @param users    当前群成员快照（从 buffer 消息中提取）
 */
export function resolveAtMentions(message: string, users: UserInfo[]): string {
  if (users.length === 0) return message;

  // 匹配 @ 后跟非空白且不是 # 开头的内容（即非 @#ID 格式）
  // 捕获到下一个空白、句末或字符串结尾
  return message.replace(/@(?!#\d)([^\s@，。！？,.!?\n]+)/g, (full, rawName) => {
    const queryName = stripTitle(rawName);
    if (!queryName) return full;

    let bestId: string | null = null;
    let bestScore = Infinity;
    let bestLen = 0;

    for (const user of users) {
      const candidateName = stripTitle(user.name);
      if (!candidateName) continue;

      const dist = levenshtein(queryName, candidateName);
      const maxLen = Math.max(queryName.length, candidateName.length);
      const similarity = 1 - dist / maxLen; // 0~1，越大越相似

      if (dist < bestScore || (dist === bestScore && candidateName.length > bestLen)) {
        bestScore = dist;
        bestId = user.id;
        bestLen = candidateName.length;
      }
    }

    // 相似度阈值：编辑距离 / max长度 <= 0.6（即相似度 >= 0.4）
    if (bestId !== null) {
      const maxLen = Math.max(queryName.length, bestLen);
      const similarity = 1 - bestScore / maxLen;
      if (similarity >= 0.4) {
        return `@#${bestId}`;
      }
    }

    return full; // 没找到合适的，原样保留
  });
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

export async function humanizedSend(
  session: Session,
  content: string,
  options?: DeliveryOptions
): Promise<void> {
  const opts = { ...defaultOptions, ...options };

  // 拆分消息
  const parts = splitMessage(content, opts.splitThreshold);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim().replace(/。$/, '');
    if (!part) continue;

    // 计算延迟
    const delay = i === 0 ? calculateDelay(part.length, opts) : Math.random() * 2000 + 1000;

    await new Promise((resolve) => setTimeout(resolve, delay));
    await session.send(part);
  }
}

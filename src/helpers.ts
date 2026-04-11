import { getAllEmojis, getEmojiByName } from "./emoji/lookup";
import { ALLOWED_REACT_EMOJI_NAMES } from "./emoji/react-policy";
import { levenshtein } from "./delivery/humanize";
import { NormalizedMessage } from "./perception/types";
import type { LLMResponse } from "./types/response";
import type { Config } from "./config";

export { ALLOWED_REACT_EMOJI_NAMES } from "./emoji/react-policy";

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

export function stickerMimeType(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return MIME_TYPES[ext] ?? "image/jpeg";
}

/**
 * 精确匹配 QQ 表情名，失败时用编辑距离模糊匹配（阈值 <= 2）
 */
export function findEmoji(
  name: string,
  options?: { allowedNames?: readonly string[]; maxDistance?: number },
): { id: string; name: string } | null {
  const normalized = String(name || "").trim().replace(/^\//, "");
  if (!normalized) return null;

  const allowedSet = options?.allowedNames
    ? new Set(options.allowedNames.map((n) => String(n || "").trim().replace(/^\//, "")))
    : null;

  const exact = getEmojiByName(normalized);
  if (exact) {
    const exactName = String(exact.name || "").trim().replace(/^\//, "");
    if (!allowedSet || allowedSet.has(exactName)) return exact;
  }

  let all = getAllEmojis();
  if (allowedSet) {
    all = Array.from(allowedSet)
      .map((allowedName) => getEmojiByName(allowedName))
      .filter((emoji): emoji is NonNullable<typeof emoji> => Boolean(emoji));
  }

  const maxDistance = options?.maxDistance ?? (allowedSet ? 0 : 2);
  let best: (typeof all)[0] | null = null;
  let bestDist = Infinity;
  for (const emoji of all) {
    if (Math.abs(normalized.length - emoji.name.length) > maxDistance) continue;
    const dist = levenshtein(normalized, emoji.name);
    if (dist < bestDist) {
      bestDist = dist;
      best = emoji;
    }
  }
  return best && bestDist <= maxDistance ? best : null;
}

/**
 * 检查消息是否显式触发 bot（@ 或提名字）
 */
export function isMentioningBot(content: string, config: Config): boolean {
  const lowerContent = content.toLowerCase();
  const names = [config.botName, ...config.botAliases].map((n) => n.toLowerCase());
  return names.some((name) => lowerContent.includes(name));
}

/**
 * 统计最近消息中连续的 bot 回复数
 */
export function countTrailingBotMessages(messages: NormalizedMessage[]): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].isBot) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/**
 * 验证 LLM 响应格式
 */
export function validateResponse(response: LLMResponse, logger: any): void {
  if (response.search) {
    if (response.actions && response.actions.length > 0) {
      logger.warn("Response has search set but non-empty actions, actions will be ignored");
    }
    return;
  }

  if (response.silent && response.actions && response.actions.length > 0) {
    logger.warn(`urge=${response.urge} (silent) but non-empty actions, ignoring actions`);
  }

  if (!response.silent && (!response.actions || response.actions.length === 0)) {
    logger.warn(`urge=${response.urge} (speak) but empty actions`);
  }
}

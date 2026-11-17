import { getAllEmojis, getEmojiByName } from "./emoji/lookup";
import { ALLOWED_REACT_EMOJI_NAMES } from "./emoji/react-policy";
import { levenshtein } from "./delivery/humanize";

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

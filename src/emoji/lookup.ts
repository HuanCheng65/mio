import { QQ_FACES } from "./qq-faces";
import type { QQEmoji } from "./qq-faces";
import { EMOJI_OVERRIDES } from "./overrides";

export type { QQEmoji } from "./qq-faces";

function normalizeName(name: string): string {
  return String(name || "").trim().replace(/^\//, "");
}

let mergedCache: QQEmoji[] | null = null;
let byIdCache: Map<string, QQEmoji> | null = null;
let byNameCache: Map<string, QQEmoji> | null = null;

function ensureCache(): void {
  if (mergedCache && byIdCache && byNameCache) return;

  const byId = new Map<string, QQEmoji>();
  for (const emoji of [...QQ_FACES, ...EMOJI_OVERRIDES]) {
    byId.set(emoji.id, { id: emoji.id, name: normalizeName(emoji.name) });
  }

  const merged = Array.from(byId.values());
  const byName = new Map<string, QQEmoji>();
  for (const emoji of merged) {
    byName.set(emoji.name, emoji);
  }

  mergedCache = merged;
  byIdCache = byId;
  byNameCache = byName;
}

export function getAllEmojis(): QQEmoji[] {
  ensureCache();
  return mergedCache!.slice();
}

export function getEmojiById(id: string): QQEmoji | undefined {
  ensureCache();
  return byIdCache!.get(String(id ?? ""));
}

export function getEmojiByName(name: string): QQEmoji | undefined {
  ensureCache();
  return byNameCache!.get(normalizeName(name));
}

import {
  getAllEmojis as getAdapterAllEmojis,
  getEmojiById as getAdapterEmojiById,
  getEmojiByName as getAdapterEmojiByName,
} from "@wittf/koishi-plugin-adapter-onebot";
import type { QQEmoji } from "@wittf/koishi-plugin-adapter-onebot";
import { EMOJI_OVERRIDES } from "./overrides";

function normalizeName(name: string): string {
  return String(name || "").trim().replace(/^\//, "");
}

function normalizeEmoji(emoji: QQEmoji): QQEmoji {
  return {
    ...emoji,
    id: String(emoji.id ?? emoji.QSid ?? ""),
    name: normalizeName(emoji.name || emoji.QDes || ""),
  };
}

let mergedCache: QQEmoji[] | null = null;
let byIdCache: Map<string, QQEmoji> | null = null;
let byNameCache: Map<string, QQEmoji> | null = null;

function ensureCache(): void {
  if (mergedCache && byIdCache && byNameCache) return;

  const byId = new Map<string, QQEmoji>();

  for (const emoji of getAdapterAllEmojis()) {
    const normalized = normalizeEmoji(emoji);
    if (!normalized.id || !normalized.name) continue;
    byId.set(normalized.id, normalized);
  }

  for (const emoji of EMOJI_OVERRIDES) {
    const normalized = normalizeEmoji(emoji);
    if (!normalized.id || !normalized.name) continue;
    byId.set(normalized.id, normalized);
  }

  const merged = Array.from(byId.values());
  const byName = new Map<string, QQEmoji>();
  for (const emoji of merged) {
    byName.set(normalizeName(emoji.name), emoji);
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
  const normalizedId = String(id ?? "");
  return byIdCache!.get(normalizedId) || getAdapterEmojiById(normalizedId);
}

export function getEmojiByName(name: string): QQEmoji | undefined {
  ensureCache();
  const normalizedName = normalizeName(name);
  return byNameCache!.get(normalizedName) || getAdapterEmojiByName(normalizedName);
}


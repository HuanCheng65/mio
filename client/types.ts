export interface TokenUsageRow {
  promptTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  completionTokens: number;
  calls: number;
}

export interface TokenUsageDetail {
  date: string;
  model: string;
  purpose: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  calls: number;
}

export interface TokenStats {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCachedTokens: number;
  totalCacheWriteTokens: number;
  totalCalls: number;
  byModel: Record<string, TokenUsageRow>;
  byPurpose: Record<string, TokenUsageRow>;
  byDate: Record<string, TokenUsageRow>;
  detail: TokenUsageDetail[];
}

export type NoteKind = "fact" | "impression" | "event" | "self" | "sticker";

export interface MemoryGroup {
  groupId: string;
  name: string | null;
  mode: string;
  notes: number;
}

export interface MemoryNote {
  id: number;
  kind: NoteKind;
  about: string;
  aboutLabel: string;
  title: string;
  content: string;
  sources: number[];
  private: boolean;
  file: string | null;
  recallCount: number;
  lastRecalledAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemorySource {
  seq: number;
  timestamp: number;
  sender: string;
  text: string;
}

export interface MemorySegment {
  segment: number;
  startedAt: number;
  tokens: number;
  summary: string | null;
}

export type PromptName = "persona" | "environment" | "reminder" | "sleep";

export interface PromptView {
  name: PromptName;
  seedFile: string;
  content: string;
  seed: string;
  edited: boolean;
  updatedAt: number | null;
}

import type { PersonaCacheStats, PersonaListItem } from "./persona-ui";

export interface PersonaSummary extends PersonaListItem {
  id: string;
  content: string;
  contentHash: string;
  createdAt: number;
  boundGroupIds: string[];
}

export interface PersonaDetail extends PersonaSummary {}

export interface TokenUsageRow {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  calls: number;
}

export interface TokenStats {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCachedTokens: number;
  totalCalls: number;
  byModel: Record<string, TokenUsageRow>;
  byPurpose: Record<string, TokenUsageRow>;
  byDate: Record<string, TokenUsageRow>;
}

export interface MemoryStats {
  enabled: boolean;
  episodic: {
    active: number;
    archived: number;
  };
  relational: number;
  semantic: number;
}

export interface PersonaDeleteResult {
  fallbackGroupIds: string[];
}

export interface PersonaConsoleSummary {
  personas: PersonaSummary[];
  cacheStats: PersonaCacheStats | null;
}

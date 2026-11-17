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

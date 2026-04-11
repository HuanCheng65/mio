import test from "node:test";
import assert from "node:assert/strict";
import { TokenTracker } from "../src/llm/token-tracker";

interface UsageItem {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  calls: number;
}

interface TokenRow extends UsageItem {
  id: number;
  date: string;
  model: string;
  purposeStats?: Record<string, UsageItem>;
}

function createFakeCtx() {
  const rows: TokenRow[] = [];

  const database = {
    async get(_table: string, query: Partial<TokenRow>) {
      return rows.filter((row) =>
        Object.entries(query).every(([key, value]) => (row as any)[key] === value),
      );
    },
    async set(_table: string, query: Partial<TokenRow>, data: Partial<TokenRow>) {
      const row = rows.find((item) =>
        Object.entries(query).every(([key, value]) => (item as any)[key] === value),
      );
      if (row) Object.assign(row, data);
    },
    async create(_table: string, data: Omit<TokenRow, "id">) {
      const row: TokenRow = { id: rows.length + 1, ...data };
      rows.push(row);
      return row;
    },
    async remove() {
      rows.length = 0;
    },
  };

  return { ctx: { database } as any, rows };
}

test("TokenTracker aggregates token usage by purpose", async () => {
  const { ctx } = createFakeCtx();
  const tracker = new TokenTracker();
  tracker.init(ctx);

  tracker.record("gpt-4o", 100, 50, 10, "conversation");
  tracker.record("gpt-4o", 30, 10, 0, "memory-extraction");
  tracker.record("gpt-4o", 5, 5, 0, "conversation");
  tracker.record("text-embedding-3-large", 20, 0, 0, "embedding");

  const stats = await tracker.getStats();

  assert.equal(stats.totalCalls, 4);
  assert.deepEqual(stats.byPurpose.conversation, {
    promptTokens: 105,
    completionTokens: 55,
    cachedTokens: 10,
    calls: 2,
  });
  assert.deepEqual(stats.byPurpose["memory-extraction"], {
    promptTokens: 30,
    completionTokens: 10,
    cachedTokens: 0,
    calls: 1,
  });
  assert.deepEqual(stats.byPurpose.embedding, {
    promptTokens: 20,
    completionTokens: 0,
    cachedTokens: 0,
    calls: 1,
  });
});

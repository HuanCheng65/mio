import test from "node:test";
import assert from "node:assert/strict";
import { GeminiCacheManager } from "../src/llm/gemini-cache";

interface DatabaseRowMap {
  "mio.gemini_cache": any[];
}

function createFakeCtx() {
  const rows: DatabaseRowMap = {
    "mio.gemini_cache": [],
  };

  const database = {
    async get(table: keyof DatabaseRowMap, query: Record<string, any>) {
      return rows[table].filter((row) =>
        Object.entries(query).every(([key, value]) => row[key] === value),
      );
    },
    async create(table: keyof DatabaseRowMap, data: Record<string, any>) {
      const row = {
        id: rows[table].length + 1,
        ...data,
      };
      rows[table].push(row);
      return row;
    },
    async remove(table: keyof DatabaseRowMap, query: Record<string, any>) {
      const removed = rows[table].filter((row) =>
        Object.entries(query).every(([key, value]) => row[key] === value),
      );
      rows[table] = rows[table].filter((row) =>
        !Object.entries(query).every(([key, value]) => row[key] === value),
      );
      return removed;
    },
  };

  return { ctx: { database } as any, rows };
}

function createFakeGemini() {
  let createCount = 0;
  const deletedNames: string[] = [];

  return {
    ai: {
      caches: {
        async create(params: any) {
          createCount += 1;
          return {
            name: `cachedContents/${createCount}`,
            model: params.model,
            displayName: params.config?.displayName,
            expireTime: "2099-01-01T00:00:00.000Z",
          };
        },
        async delete(params: { name: string }) {
          deletedNames.push(params.name);
        },
      },
    } as any,
    get createCount() {
      return createCount;
    },
    deletedNames,
  };
}

test("GeminiCacheManager reuses a valid static-core cache by cacheKey", async () => {
  const { ctx } = createFakeCtx();
  const gemini = createFakeGemini();
  const manager = new GeminiCacheManager(ctx, gemini.ai);

  const cacheA = await manager.ensureStaticCoreCache({
    cacheKey: "abc",
    modelName: "gemini-3-flash-preview",
    personaId: "default",
    personaHash: "hash-a",
    promptVersion: "v1",
    staticCoreText: "core",
  });

  const cacheB = await manager.ensureStaticCoreCache({
    cacheKey: "abc",
    modelName: "gemini-3-flash-preview",
    personaId: "default",
    personaHash: "hash-a",
    promptVersion: "v1",
    staticCoreText: "core",
  });

  assert.equal(cacheA.cacheName, cacheB.cacheName);
  assert.equal(gemini.createCount, 1);
});

test("GeminiCacheManager invalidates persona caches and requests Gemini deletion", async () => {
  const { ctx, rows } = createFakeCtx();
  const gemini = createFakeGemini();
  const manager = new GeminiCacheManager(ctx, gemini.ai);

  await manager.ensureStaticCoreCache({
    cacheKey: "abc",
    modelName: "gemini-3-flash-preview",
    personaId: "default",
    personaHash: "hash-a",
    promptVersion: "v1",
    staticCoreText: "core",
  });

  await manager.invalidatePersonaCaches("default");

  assert.equal(rows["mio.gemini_cache"].length, 0);
  assert.deepEqual(gemini.deletedNames, ["cachedContents/1"]);
});

test("GeminiCacheManager deduplicates concurrent cache creation for the same key", async () => {
  const { ctx } = createFakeCtx();
  let createCount = 0;
  let releaseCreate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const ai = {
    caches: {
      async create() {
        createCount += 1;
        await gate;
        return {
          name: "cachedContents/concurrent",
          expireTime: "2099-01-01T00:00:00.000Z",
        };
      },
      async delete() {},
    },
  } as any;
  const manager = new GeminiCacheManager(ctx, ai);
  const input = {
    cacheKey: "same",
    modelName: "gemini-3-flash-preview",
    personaId: "default",
    personaHash: "hash-a",
    promptVersion: "v1",
    staticCoreText: "core",
  };

  const promiseA = manager.ensureStaticCoreCache(input);
  const promiseB = manager.ensureStaticCoreCache(input);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(createCount, 1);

  releaseCreate();
  const [cacheA, cacheB] = await Promise.all([promiseA, promiseB]);
  assert.equal(cacheA.cacheName, cacheB.cacheName);
});

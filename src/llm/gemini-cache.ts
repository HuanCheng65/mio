import { Context } from "koishi";
import type { MioGeminiCacheRow } from "../persona/types";

export interface EnsureStaticCoreCacheInput {
  cacheKey: string;
  modelName: string;
  personaId: string;
  personaHash: string;
  promptVersion: string;
  staticCoreText: string;
}

export interface GeminiCacheRecord extends MioGeminiCacheRow {}

const STATIC_CORE_LAYER = "static_core";
const DEFAULT_TTL_MS = 60 * 60 * 1000;

function toExpiresAt(expireTime?: string): number {
  if (!expireTime) {
    return Date.now() + DEFAULT_TTL_MS;
  }

  const parsed = Date.parse(expireTime);
  return Number.isNaN(parsed) ? Date.now() + DEFAULT_TTL_MS : parsed;
}

export class GeminiCacheManager {
  private inflight = new Map<string, Promise<GeminiCacheRecord>>();

  constructor(
    private readonly ctx: Context,
    private readonly ai: any,
  ) {}

  async ensureStaticCoreCache(input: EnsureStaticCoreCacheInput): Promise<GeminiCacheRecord> {
    const existing = await this.findFreshCache(input.cacheKey, input.modelName);
    if (existing) {
      return existing;
    }

    const inflightKey = this.getInflightKey(input.cacheKey, input.modelName);
    const pending = this.inflight.get(inflightKey);
    if (pending) {
      return pending;
    }

    const created = this.createStaticCoreCache(input).finally(() => {
      this.inflight.delete(inflightKey);
    });
    this.inflight.set(inflightKey, created);
    return created;
  }

  async invalidatePersonaCaches(personaId: string): Promise<void> {
    const rows = await this.ctx.database.get("mio.gemini_cache", { personaId });
    await this.deleteRows(rows);
  }

  async invalidateAllCaches(): Promise<void> {
    const rows = await this.ctx.database.get("mio.gemini_cache", {});
    await this.deleteRows(rows);
  }

  async invalidateByCacheKey(cacheKey: string): Promise<void> {
    const rows = await this.ctx.database.get("mio.gemini_cache", { cacheKey });
    await this.deleteRows(rows);
  }

  private getInflightKey(cacheKey: string, modelName: string): string {
    return `${STATIC_CORE_LAYER}:${modelName}:${cacheKey}`;
  }

  private async createStaticCoreCache(input: EnsureStaticCoreCacheInput): Promise<GeminiCacheRecord> {
    const existing = await this.findFreshCache(input.cacheKey, input.modelName);
    if (existing) {
      return existing;
    }

    const created = await this.ai.caches.create({
      model: input.modelName,
      config: {
        contents: [{ role: "user", parts: [{ text: input.staticCoreText }] }],
        displayName: `mio-static-${input.personaId}`,
        ttl: "3600s",
      },
    });

    return this.persist(created, input);
  }

  private async findFreshCache(cacheKey: string, modelName: string): Promise<GeminiCacheRecord | null> {
    const rows = await this.ctx.database.get("mio.gemini_cache", {
      cacheKey,
      modelName,
      layer: STATIC_CORE_LAYER,
    });

    const fresh = rows
      .filter((row) => row.expiresAt > Date.now())
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];

    if (fresh) {
      return fresh;
    }

    const stale = rows.filter((row) => row.expiresAt <= Date.now());
    if (stale.length > 0) {
      await this.deleteRows(stale);
    }

    return null;
  }

  private async persist(created: any, input: EnsureStaticCoreCacheInput): Promise<GeminiCacheRecord> {
    const now = Date.now();
    const row = await this.ctx.database.create("mio.gemini_cache", {
      layer: STATIC_CORE_LAYER,
      cacheKey: input.cacheKey,
      personaId: input.personaId,
      personaHash: input.personaHash,
      promptVersion: input.promptVersion,
      modelName: input.modelName,
      cacheName: created.name ?? "",
      expiresAt: toExpiresAt(created.expireTime),
      updatedAt: now,
    } as GeminiCacheRecord);

    return row;
  }

  private async deleteRows(rows: GeminiCacheRecord[]): Promise<void> {
    for (const row of rows) {
      if (row.cacheName) {
        try {
          await this.ai.caches.delete({ name: row.cacheName });
        } catch {}
      }
      await this.ctx.database.remove("mio.gemini_cache", { id: row.id });
    }
  }
}

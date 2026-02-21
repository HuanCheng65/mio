# Sticker System Design

> **Version**: 1.0 — 2026-02-21
> **Status**: Approved

---

## Overview

A sticker (表情包) system that simulates how a real person collects and uses stickers in group chat. Not a search engine — a system with aesthetic preferences, usage habits, and natural metabolism.

Three pipelines: ingestion (collect from group), usage (retrieve and send), maintenance (quality evolution and eviction).

---

## Architecture Integration

### New Files

| File | Purpose |
|------|---------|
| `src/sticker/types.ts` | `Sticker` interface, `VLMImageAnalysis` response type |
| `src/sticker/db.ts` | Database helpers (CRUD, hash search, embedding search, use recording) |
| `src/sticker/ingestion.ts` | Collection pipeline: dedup → embed × 3 → score → store → evict |
| `src/sticker/retrieval.ts` | Three-path retrieval + rerank + threshold |
| `src/sticker/maintenance.ts` | Quality score updates, eviction, weekly dedup, summary generation |
| `src/sticker/index.ts` | `StickerService` facade |

### Modified Files

| File | Change |
|------|--------|
| `src/pipeline/image-processor.ts` | VLM prompt → JSON output; pass sticker metadata to `StickerService.maybeCollect()` |
| `src/memory/tables.ts` | Add `mio.sticker` table declaration |
| `src/types/response.ts` | Add `StickerAction` to `Action` union |
| `data/prompts.yaml` | Add `sticker` action type to Layer 2 + one few-shot example |
| `src/index.tsx` | Handle sticker action; inject library summary into Layer 3; wire maintenance; add config fields |
| `src/memory/distillation.ts` | Call `StickerService.runDailyMaintenance()` and `runWeeklyDedup()` |

---

## Database Schema

Uses Koishi DB abstraction (adds `mio.sticker` table to `memory/tables.ts`). Embeddings stored as `number[]` serialized as JSON, consistent with existing `mio.episodic` pattern.

```typescript
interface StickerRow {
  id: string;
  image_path: string;
  phash: string;
  description: string;
  vibe_tags: string[];
  style_tags: string[];
  scene: string;
  vibe_embedding: number[];
  scene_embedding: number[];
  content_embedding: number[];
  source_user: string;
  collected_at: number;
  use_count: number;
  last_used: number | null;
  encounter_count: number;
  status: 'active' | 'archived';
  quality_score: number;
  created_at: number;
}
```

Cosine similarity for embedding search is computed in application code over active stickers, same pattern as `memory/episodic.ts`.

---

## VLM Integration

One combined VLM call per image (zero marginal cost). `image-processor.ts` prompt changes from plain text to the JSON prompt in the original design doc (section 2). The `description` field continues to be used as `[图片：...]` in chat history — no behavior change for the rest of the system.

---

## Action Type

```typescript
interface StickerAction {
  type: 'sticker';
  intent: string;  // natural language: "笑死 太惨了 幸灾乐祸"
}
```

Added to `Action` union in `src/types/response.ts`. Main LLM outputs this; post-processing retrieves the actual image.

---

## Key Integration Points

### Sticker Action Execution (`src/index.tsx`)
In the action execution loop, `sticker` case calls `StickerService.resolveSticker(intent)`. Returns image path or `null`. If `null`, silently skip (no fallback text).

### Library Summary Injection (`src/index.tsx`)
Before prompt build, append daily-cached sticker summary to Layer 3 dynamic context. If library empty or summary unavailable, inject nothing.

### Maintenance Hooks (`src/memory/distillation.ts`)
- `StickerService.runDailyMaintenance()` — quality score recalc + eviction + summary regen
- `StickerService.runWeeklyDedup()` — cosine similarity dedup across active pool

### Config Additions
```typescript
sticker: {
  enabled: Schema.boolean().default(true),
  maxPoolSize: Schema.number().default(80),
  imageDir: Schema.string().default('./data/stickers'),
}
```

---

## Implementation Phases

### Phase A — Collection + Storage
1. VLM prompt update in `image-processor.ts`
2. `mio.sticker` table in `tables.ts`
3. phash dedup
4. Embedding × 3 (reuse `memory/embedding.ts`)
5. Ingestion pipeline end-to-end

**Verification**: Stickers auto-collected; non-stickers not collected (>80%); duplicates not re-stored.

### Phase B — Usage Pipeline
1. `sticker` action type in `response.ts` and `prompts.yaml` + one few-shot
2. Three-path retrieval
3. Rerank
4. Threshold + graceful skip
5. Send via Koishi file API

**Verification**: Main LLM occasionally generates sticker action; retrieval finds relevant stickers; graceful skip when no match.

### Phase C — Maintenance + Polish
1. `quality_score` dynamic updates
2. Capacity eviction
3. Weekly similarity dedup
4. Library summary generation + injection
5. Seed sticker loader

**Verification**: Frequently used stickers rank higher; unused ones decay; library summary appears in prompt.

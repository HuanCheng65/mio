# Mio Persona Management, Cache, and Console Design

**Date:** 2026-04-20

**Goal:** Add database-backed multi-persona support, a Koishi console persona management studio, and a layered Gemini explicit caching architecture that is ready for future semi-static group context caching.

## Problem

Mio currently assumes a single global persona file configured by `personaFile`. That blocks:

- binding different full personas to different groups
- editing personas directly in the Koishi console
- invalidating and rebuilding prompt caches when persona content changes
- separating stable prompt layers from semi-static and real-time layers

At the same time, the current Gemini integration only observes cache hits. It does not manage explicit caches, so repeated static prompt prefixes are not guaranteed to benefit from stable cache reuse.

## Requirements

### Functional

- Support multiple full personas, each equivalent in shape to the current `mio.md`
- Allow each group to bind to one persona
- Fall back to the default persona when a group has no explicit binding
- Store personas in the database as the source of truth
- Seed the default persona from `data/persona/mio.md` when the database is empty
- Provide a Koishi console UI to:
  - create personas
  - duplicate personas
  - rename personas
  - delete personas
  - edit full persona markdown
  - set the default persona
  - bind and unbind groups
- Make persona edits take effect immediately
- Warn before deleting a persona that is still bound by groups
- If deletion is confirmed, automatically return affected groups to the default persona
- Add Gemini explicit cache management for the stable prompt core
- Keep the architecture ready for a second semi-static cache layer later

### Non-Functional

- Do not introduce backward-compatibility code paths unless explicitly requested later
- Keep the operator mental model simple
- Preserve current conversation behavior when no custom personas are configured
- Avoid blocking conversations if cache operations fail
- Use mature SVG icon libraries only in the console UI

## Decisions

### 1. Persona source of truth

Personas will live in the database, not in runtime-edited files.

`data/persona/mio.md` remains only as an initialization seed. On startup, if no default persona exists, Mio imports that file into the database and marks it as the default persona. After initialization, runtime reads and writes use only database records.

This avoids mixing published package assets with mutable runtime state and makes group bindings, editing, and cache invalidation much easier to manage.

### 2. Group persona behavior

Each group resolves its active persona at runtime:

- if the group has an explicit binding, use that persona
- otherwise, use the default persona

This keeps the behavior straightforward and avoids storing redundant “default binding” rows.

### 3. Cache philosophy

Explicit cache scope is based on **content stability**, not on `groupId` by default.

The first cache layer stores only the truly stable static core:

- chat system layer 0
- chat system layer 1
- chat system layer 2
- resolved persona content

If two groups resolve to the same persona content and the same static prompt version, they should share the same first-layer cache. `groupId` should not be forced into that key.

The second cache layer is only a future extension point. It is intended for semi-static content such as `groupCulture`, but it is not enabled in this phase.

## Architecture

## Runtime services

### PersonaService

Responsible for:

- CRUD for personas
- default persona management
- group-to-persona binding management
- startup seeding from `data/persona/mio.md`
- resolving the effective persona for a group

Returned persona payload should include:

- `id`
- `name`
- `content`
- `contentHash`
- `isDefault`
- timestamps

### PromptStaticCoreBuilder

Builds the cacheable first-layer static prompt core from:

- `chat_system_layer0_cognitive`
- `chat_system_layer1_behavior`
- `chat_system_layer2_format`
- resolved persona content

This builder is separate from the full prompt builder so cacheable and non-cacheable prompt sections are explicit in code.

### GeminiCacheManager

Responsible for:

- looking up existing cache metadata
- validating cache freshness and prompt compatibility
- creating explicit caches on demand
- deleting stale caches
- exposing cache hit and miss metadata for logs

Phase 1 enables only the first layer.

Phase 2 can add a second layer for semi-static content without changing the first-layer contract.

### PromptBuilder

Prompt assembly becomes layered:

1. static core: cacheable
2. semi-static group layer: not cached yet, but architecturally separate
3. dynamic runtime layer: memories, sticker summary, current time, recent messages, new messages

## Data model

### `mio.persona`

- `id`: stable primary key
- `name`: display name
- `content`: full markdown persona text
- `contentHash`: hash of full content
- `isDefault`: boolean, exactly one row should be true
- `createdAt`
- `updatedAt`

### `mio.group_persona_binding`

- `groupId`
- `personaId`
- `updatedAt`

Only explicit bindings are stored. Absence means “use default persona”.

### `mio.gemini_cache`

- `id`
- `layer`: `static_core` for this phase
- `modelName`
- `cacheKey`
- `personaId`
- `personaHash`
- `promptVersion`
- `cacheName`: Gemini cached content name
- `expiresAt`
- `updatedAt`

This table tracks local metadata for Gemini explicit caches so Mio can invalidate, rebuild, or clean up caches safely.

## Cache key design

### Enabled in this phase

First-layer cache key:

- `hash(staticCoreText + modelName + promptVersion)`

Where `staticCoreText` is the exact cacheable prompt core after static substitutions such as the allowed react emoji list.

### Reserved for later

Second-layer key shape:

- `hash(staticCoreKey + semiStaticSnapshot + modelName + semiStaticVersion)`

This is intentionally not enabled yet, but the code structure should make it easy to add.

## Prompt versioning

`promptVersion` should change when the static core changes, including:

- layer 0 template
- layer 1 template
- layer 2 template
- static substitutions used in layer 2

This avoids reusing a cache built for an older prompt core after `prompts.yaml` changes.

## Console UI

## Interaction model

The Koishi console should expose a three-column persona studio inside the existing Mio page.

### Top summary strip

Shows:

- default persona name
- total persona count
- total explicitly bound groups
- cache summary

Primary actions:

- create persona
- import or reset default seed if needed
- refresh cache state

### Left column: persona list

Includes:

- search field
- persona list with selection state
- per-item summary:
  - name
  - default badge
  - bound group count
  - updated time

### Center column: editor

Includes:

- persona name header
- save state badge: saved, saving, failed
- full markdown editor for persona content
- quick actions:
  - duplicate
  - rename
  - set as default

Saving should apply immediately after a successful submit.

### Right column: inspector

Includes:

- persona metadata:
  - id
  - content hash
  - updated time
- bound groups list
- bind and unbind controls
- destructive zone for deletion with impact preview

## UI rules

- Use mature SVG icon libraries only
- No emoji icons
- Hover states must not shift layout
- Provide explicit loading, success, and error feedback
- Show confirmation dialogs before destructive actions
- Mobile layout should collapse from three columns into stacked panels or drawers

## Immediate-effect flows

### Save persona content

1. Update `mio.persona`
2. Recompute `contentHash`
3. Mark matching first-layer cache metadata invalid
4. Delete matching Gemini cached content if present
5. Future requests lazily create a new cache when needed

### Set default persona

1. Switch `isDefault`
2. Do not rewrite group bindings
3. Unbound groups automatically resolve to the new default persona on next request

### Change group binding

1. Update or remove `mio.group_persona_binding`
2. Next request for that group resolves the new persona immediately
3. No forced eager cache creation

### Delete persona

1. Query impacted groups
2. Present confirmation dialog with affected group count
3. If confirmed:
   - delete group bindings to that persona
   - delete persona row
   - delete related cache metadata and Gemini caches
4. Impacted groups resolve to the default persona on the next request

## Failure handling

- If explicit cache creation fails, continue with a normal Gemini request
- If a stored cache record points to a missing or expired Gemini cache, clean local metadata and rebuild lazily later
- If console save fails, keep the unsaved editor content in the UI and show explicit error feedback
- If database bootstrap cannot establish a default persona, fail startup loudly instead of running partially configured

## Observability

Conversation logging should include:

- resolved `personaId`
- resolved persona name
- shortened `personaHash`
- cache layer used
- cache hit source: `explicit`, `implicit-only`, or `none`
- `cachedTokens`
- cache name when explicit cache is used

This is required so future cache ratio problems can be debugged without guessing.

## Prompt cleanup noted during investigation

Current conversation prompt generation duplicates the newest messages:

- once in the rendered recent message history
- once again in the user prompt marker block

This is not the root cause of zero cached token observations, but it inflates prompt token counts and should be corrected during implementation.

## Out of scope for this phase

- enabling second-layer semi-static cache storage
- versioned persona history or rollback UI
- collaborative editing
- file-to-database round-trip sync after bootstrap

## Recommended implementation order

1. Add persona and cache tables
2. Add database-backed persona service and group binding resolution
3. Refactor prompt building into cacheable static core plus dynamic remainder
4. Add Gemini explicit cache manager for the first layer
5. Wire runtime persona resolution and cache lookup into conversation flow
6. Add console backend listeners for persona management
7. Build the console persona studio UI
8. Add observability and regression tests

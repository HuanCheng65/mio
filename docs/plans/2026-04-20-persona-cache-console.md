# Persona, Cache, and Console Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build database-backed multi-persona support, a Koishi console persona studio, and first-layer Gemini explicit cache management for Mio.

**Architecture:** Move persona storage and group bindings into a dedicated `persona` module, split prompt assembly into a cacheable static core plus dynamic remainder, and add a Gemini cache manager that creates and reuses explicit caches keyed by static content. The console gains a three-column persona studio backed by new console listeners, with saves taking effect immediately and cache invalidation happening lazily.

**Tech Stack:** TypeScript, Koishi, Vue 3, `node:test`, Gemini API via `@google/genai`, yarn workspaces

---

### Task 1: Add Persona Tables and Data Service

**Files:**
- Create: `src/persona/types.ts`
- Create: `src/persona/service.ts`
- Test: `test/persona-service.test.ts`
- Modify: `src/index.tsx`

**Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { PersonaService, seedDefaultPersonaIfMissing } from "../src/persona/service";

test("PersonaService resolves bound personas and falls back to default", async () => {
  const service = new PersonaService(createFakeCtx(), {
    defaultPersonaSeedFile: "mio.md",
  });

  await seedDefaultPersonaIfMissing(service);
  const alt = await service.createPersona({ name: "Alt", content: "# alt" });
  await service.bindGroup("123", alt.id);

  const bound = await service.resolveForGroup("123");
  const fallback = await service.resolveForGroup("999");

  assert.equal(bound.name, "Alt");
  assert.equal(fallback.isDefault, true);
});
```

**Step 2: Run test to verify it fails**

Run: `yarn exec tsx --test external/mio/test/persona-service.test.ts`

Expected: FAIL because `src/persona/service.ts` and the persona table logic do not exist yet.

**Step 3: Write minimal implementation**

```ts
export interface PersonaRecord {
  id: string;
  name: string;
  content: string;
  contentHash: string;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export class PersonaService {
  async createPersona(input: { name: string; content: string }) { /* insert row */ }
  async bindGroup(groupId: string, personaId: string) { /* upsert binding */ }
  async resolveForGroup(groupId: string): Promise<PersonaRecord> { /* binding or default */ }
}
```

Add table registration during startup so personas are available even when memory is disabled.

**Step 4: Run test to verify it passes**

Run: `yarn exec tsx --test external/mio/test/persona-service.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add external/mio/test/persona-service.test.ts external/mio/src/persona/types.ts external/mio/src/persona/service.ts external/mio/src/index.tsx
git commit -m "feat(persona): add database-backed persona service"
```

### Task 2: Register Persona and Cache Metadata Tables

**Files:**
- Modify: `src/persona/types.ts`
- Modify: `src/persona/service.ts`
- Test: `test/persona-tables.test.ts`

**Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { extendPersonaTables } from "../src/persona/types";

test("extendPersonaTables registers persona, binding, and cache tables", () => {
  const extended: string[] = [];
  const ctx = {
    model: {
      extend(name: string) {
        extended.push(name);
      },
    },
  } as any;

  extendPersonaTables(ctx);

  assert.deepEqual(extended.sort(), [
    "mio.gemini_cache",
    "mio.group_persona_binding",
    "mio.persona",
  ]);
});
```

**Step 2: Run test to verify it fails**

Run: `yarn exec tsx --test external/mio/test/persona-tables.test.ts`

Expected: FAIL because the table extender is missing.

**Step 3: Write minimal implementation**

```ts
export function extendPersonaTables(ctx: Context) {
  ctx.model.extend("mio.persona", { /* schema */ }, { primary: "id" });
  ctx.model.extend("mio.group_persona_binding", { /* schema */ }, { unique: [["groupId"]] });
  ctx.model.extend("mio.gemini_cache", { /* schema */ }, { autoInc: true, primary: "id" });
}
```

The cache table should store:

- `layer`
- `cacheKey`
- `personaId`
- `personaHash`
- `promptVersion`
- `modelName`
- `cacheName`
- `expiresAt`
- `updatedAt`

**Step 4: Run test to verify it passes**

Run: `yarn exec tsx --test external/mio/test/persona-tables.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add external/mio/test/persona-tables.test.ts external/mio/src/persona/types.ts external/mio/src/persona/service.ts
git commit -m "feat(persona): add persona and cache metadata tables"
```

### Task 3: Split Prompt Building into Static Core and Dynamic Remainder

**Files:**
- Modify: `src/context/prompt-builder.ts`
- Modify: `src/runtime/conversation.ts`
- Test: `test/prompt-builder-static-core.test.ts`

**Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { PromptBuilder } from "../src/context/prompt-builder";

test("PromptBuilder exposes stable static core separately from dynamic prompt body", () => {
  const builder = new PromptBuilder("mio.md");
  const core = builder.buildStaticCore({ personaContent: "# persona" });
  const full = builder.buildSystemPrompt({
    personaContent: "# persona",
    recentMessages: "[m1] hi",
    userProfile: "- Echo",
  });

  assert.match(core.text, /认知框架/);
  assert.equal(full.startsWith(core.text), true);
});
```

**Step 2: Run test to verify it fails**

Run: `yarn exec tsx --test external/mio/test/prompt-builder-static-core.test.ts`

Expected: FAIL because `buildStaticCore()` does not exist.

**Step 3: Write minimal implementation**

```ts
buildStaticCore(options: { personaContent: string }) {
  const text = [layer0, layer1, layer2, options.personaContent].join("\n");
  const promptVersion = createHash("sha256").update(text).digest("hex");
  return { text, promptVersion };
}
```

Update `buildSystemPrompt()` to consume the static core and append only the dynamic sections.

While editing `processConversation()`, remove the duplicated “new messages” prompt inflation by ensuring the newest messages are not injected twice as both fresh history and repeated user payload content.

**Step 4: Run test to verify it passes**

Run: `yarn exec tsx --test external/mio/test/prompt-builder-static-core.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add external/mio/test/prompt-builder-static-core.test.ts external/mio/src/context/prompt-builder.ts external/mio/src/runtime/conversation.ts
git commit -m "refactor(prompt): split static core from dynamic layers"
```

### Task 4: Add Gemini Explicit Cache Manager

**Files:**
- Create: `src/llm/gemini-cache.ts`
- Test: `test/gemini-cache-manager.test.ts`
- Modify: `src/persona/service.ts`

**Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { GeminiCacheManager } from "../src/llm/gemini-cache";

test("GeminiCacheManager reuses a valid static-core cache by cacheKey", async () => {
  const manager = new GeminiCacheManager(createFakeCtx(), createFakeGemini());

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
});
```

**Step 2: Run test to verify it fails**

Run: `yarn exec tsx --test external/mio/test/gemini-cache-manager.test.ts`

Expected: FAIL because the cache manager does not exist.

**Step 3: Write minimal implementation**

```ts
export class GeminiCacheManager {
  async ensureStaticCoreCache(input: EnsureStaticCoreCacheInput) {
    const existing = await this.findFreshCache(input.cacheKey, input.modelName);
    if (existing) return existing;

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
}
```

Also add `invalidatePersonaCaches(personaId)` and `invalidateByCacheKey(cacheKey)` to support immediate-effect saves and deletes.

**Step 4: Run test to verify it passes**

Run: `yarn exec tsx --test external/mio/test/gemini-cache-manager.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add external/mio/test/gemini-cache-manager.test.ts external/mio/src/llm/gemini-cache.ts external/mio/src/persona/service.ts
git commit -m "feat(cache): add Gemini explicit cache manager"
```

### Task 5: Wire Cache Usage into Gemini Chat Requests

**Files:**
- Modify: `src/llm/client.ts`
- Modify: `src/runtime/types.ts`
- Modify: `src/index.tsx`
- Modify: `src/runtime/conversation.ts`
- Test: `test/llm-client-gemini-cache.test.ts`

**Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { LLMClient } from "../src/llm/client";

test("LLMClient forwards cachedContent to Gemini generateContent", async () => {
  const fakeProvider = createFakeGeminiProvider();
  const client = new LLMClient(createProviderManager(fakeProvider));

  await client.chat(
    [{ role: "user", content: "hi" }],
    { providerId: "gemini", modelName: "gemini-3-flash-preview" },
    { cachedContent: "cachedContents/123" },
  );

  assert.equal(fakeProvider.lastRequest.config.cachedContent, "cachedContents/123");
});
```

**Step 2: Run test to verify it fails**

Run: `yarn exec tsx --test external/mio/test/llm-client-gemini-cache.test.ts`

Expected: FAIL because `ChatOptions.cachedContent` is unsupported.

**Step 3: Write minimal implementation**

```ts
export interface ChatOptions {
  cachedContent?: string;
}

if (options?.cachedContent) {
  config.cachedContent = options.cachedContent;
}
```

Update runtime wiring so `processConversation()`:

- resolves the effective persona
- builds the static core
- asks the cache manager for a cache
- passes `cachedContent` into `llm.chat()`

If cache creation fails, log it and continue without `cachedContent`.

**Step 4: Run test to verify it passes**

Run: `yarn exec tsx --test external/mio/test/llm-client-gemini-cache.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add external/mio/test/llm-client-gemini-cache.test.ts external/mio/src/llm/client.ts external/mio/src/runtime/types.ts external/mio/src/index.tsx external/mio/src/runtime/conversation.ts
git commit -m "feat(cache): use explicit Gemini cache in conversation flow"
```

### Task 6: Add Console Backend APIs for Personas and Bindings

**Files:**
- Modify: `src/console-listeners.ts`
- Modify: `src/index.tsx`
- Modify: `src/runtime/commands.ts`
- Test: `test/persona-console-api.test.ts`

**Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { registerConsoleListeners } from "../src/console-listeners";

test("console listeners expose persona CRUD and binding events", async () => {
  const registered: string[] = [];
  const ctx = createFakeConsoleCtx(registered);

  registerConsoleListeners(ctx as any, console, null as any, createFakePersonaService() as any);

  assert.ok(registered.includes("mio/persona-list"));
  assert.ok(registered.includes("mio/persona-save"));
  assert.ok(registered.includes("mio/persona-delete"));
  assert.ok(registered.includes("mio/persona-bind-group"));
});
```

**Step 2: Run test to verify it fails**

Run: `yarn exec tsx --test external/mio/test/persona-console-api.test.ts`

Expected: FAIL because the persona console listeners do not exist.

**Step 3: Write minimal implementation**

Add listeners for:

- `mio/persona-list`
- `mio/persona-get`
- `mio/persona-create`
- `mio/persona-duplicate`
- `mio/persona-rename`
- `mio/persona-save`
- `mio/persona-delete`
- `mio/persona-set-default`
- `mio/persona-bind-group`
- `mio/persona-unbind-group`
- `mio/persona-cache-stats`

Each listener should delegate to `PersonaService` and invalidate caches when content or bindings change.

**Step 4: Run test to verify it passes**

Run: `yarn exec tsx --test external/mio/test/persona-console-api.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add external/mio/test/persona-console-api.test.ts external/mio/src/console-listeners.ts external/mio/src/index.tsx external/mio/src/runtime/commands.ts
git commit -m "feat(console): add persona management backend events"
```

### Task 7: Build the Koishi Console Persona Studio

**Files:**
- Modify: `client/page.vue`
- Create: `client/persona-ui.ts`
- Modify: `client/index.ts`
- Modify: `package.json`
- Test: `test/persona-ui.test.ts`

**Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildDeletePersonaWarning, summarizePersonaRow } from "../client/persona-ui";

test("buildDeletePersonaWarning includes fallback impact wording", () => {
  const text = buildDeletePersonaWarning("澪-alt", ["123", "456"]);
  assert.match(text, /恢复到默认/);
  assert.match(text, /2 个群/);
});
```

**Step 2: Run test to verify it fails**

Run: `yarn exec tsx --test external/mio/test/persona-ui.test.ts`

Expected: FAIL because the helper module does not exist.

**Step 3: Write minimal implementation**

```ts
export function buildDeletePersonaWarning(name: string, groupIds: string[]) {
  return `删除 ${name} 后，${groupIds.length} 个群会恢复到默认人设。`;
}
```

Then update `client/page.vue` into a three-column persona studio:

- left: searchable persona list
- center: markdown editor with save state
- right: inspector with group bindings and delete warning

Use a mature SVG icon library such as `lucide-vue-next`. Do not hand-draw icons.

Show:

- toasts on create/save/duplicate/delete/bind success
- loading states for async actions
- confirmation modal before delete
- unsaved-change guard when switching personas

**Step 4: Run test to verify it passes**

Run: `yarn exec tsx --test external/mio/test/persona-ui.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add external/mio/test/persona-ui.test.ts external/mio/client/persona-ui.ts external/mio/client/page.vue external/mio/client/index.ts external/mio/package.json
git commit -m "feat(console): add persona studio UI"
```

### Task 8: Add Logging, Verification, and Final Build Checks

**Files:**
- Modify: `src/runtime/conversation.ts`
- Modify: `src/llm/token-tracker.ts`
- Test: `test/conversation-cache-observability.test.ts`
- Verify: `docs/plans/2026-04-20-persona-cache-console-design.md`

**Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { formatConversationCacheLog } from "../src/persona/service";

test("formatConversationCacheLog includes persona and cache hit metadata", () => {
  const line = formatConversationCacheLog({
    personaId: "default",
    personaName: "澪",
    personaHash: "abcdef123456",
    cacheHitSource: "explicit",
    cachedTokens: 6054,
  });

  assert.match(line, /persona=default/);
  assert.match(line, /cache=explicit/);
  assert.match(line, /6054/);
});
```

**Step 2: Run test to verify it fails**

Run: `yarn exec tsx --test external/mio/test/conversation-cache-observability.test.ts`

Expected: FAIL because the logging helper does not exist.

**Step 3: Write minimal implementation**

Add structured logging for:

- persona id and name
- shortened persona hash
- cache key or cache name
- cache hit source
- cached tokens

Do not alter token accounting semantics. This task is about observability, not a tracker redesign.

**Step 4: Run focused tests and build**

Run:

```bash
yarn exec tsx --test external/mio/test/persona-service.test.ts
yarn exec tsx --test external/mio/test/persona-tables.test.ts
yarn exec tsx --test external/mio/test/prompt-builder-static-core.test.ts
yarn exec tsx --test external/mio/test/gemini-cache-manager.test.ts
yarn exec tsx --test external/mio/test/llm-client-gemini-cache.test.ts
yarn exec tsx --test external/mio/test/persona-console-api.test.ts
yarn exec tsx --test external/mio/test/persona-ui.test.ts
yarn exec tsx --test external/mio/test/conversation-cache-observability.test.ts
yarn build
```

Expected:

- all targeted tests PASS
- repo root build PASS when run from `E:\danmaku\next-danmaku-bot`

**Step 5: Commit**

```bash
git add external/mio/test/conversation-cache-observability.test.ts external/mio/src/runtime/conversation.ts external/mio/src/llm/token-tracker.ts
git commit -m "chore(observability): log persona and cache metadata"
```

### Final Verification Checklist

- Groups without bindings resolve the default persona
- Persona save takes effect on the next conversation without restart
- Deleting a bound persona warns first and then falls back to default after confirmation
- First-layer explicit cache is created lazily and reused by matching static content
- Cache failures do not block conversations
- Console UI uses mature SVG icons only
- Prompt static core is separated from dynamic layers
- The duplicated “new message” prompt inflation is removed


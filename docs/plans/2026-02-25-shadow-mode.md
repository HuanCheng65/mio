# Shadow Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a per-group shadow mode that runs full LLM inference but suppresses all outgoing actions, logging decisions to JSONL files for observation.

**Architecture:** New `shadowGroups` config controls which groups are in shadow mode. A `ShadowLogger` module handles JSONL file writes. Interception happens in `processConversation` and `handleSearch` after LLM response parsing — if the group is shadowed, log the response and skip action execution.

**Tech Stack:** Node.js `fs` for file I/O, existing Koishi config schema system.

---

### Task 1: Add `shadowGroups` config option

**Files:**
- Modify: `src/config.ts:4` (interface) and `src/config.ts:59-61` (schema)

**Step 1: Add `shadowGroups` to the Config interface**

In `src/config.ts`, add after line 8 (`enableGroups: string[];`):

```ts
shadowGroups: string[];
```

**Step 2: Add schema definition**

In `src/config.ts`, add after the `enableGroups` schema definition (after line 61):

```ts
shadowGroups: Schema.array(Schema.string().pattern(/^\d+$/))
  .default([])
  .description("影子模式群号（正常推理但不发送消息，记录到日志）"),
```

**Step 3: Verify build**

Run: `cd E:\danmaku\next-danmaku-bot && yarn build`
Expected: Build succeeds with no errors.

---

### Task 2: Create `ShadowLogger` module

**Files:**
- Create: `src/shadow-logger.ts`
- Test: `test/shadow-logger.test.ts`

**Step 1: Write the test**

Create `test/shadow-logger.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ShadowLogger } from "../src/shadow-logger";

test("ShadowLogger writes JSONL entries to per-group files", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-test-"));
  const logger = new ShadowLogger(tmpDir);

  logger.log({
    groupId: "123",
    phase: "main",
    newMessages: [{ sender: "Alice", content: "hello" }],
    thought: "greeting",
    urge: 8,
    silent: false,
    actions: [{ type: "message", content: "hi" }],
    search: null,
  });

  logger.log({
    groupId: "123",
    phase: "main",
    newMessages: [{ sender: "Bob", content: "bye" }],
    thought: "farewell",
    urge: 3,
    silent: true,
    actions: [],
    search: null,
  });

  const filePath = path.join(tmpDir, "123.jsonl");
  assert.ok(fs.existsSync(filePath));

  const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
  assert.equal(lines.length, 2);

  const entry1 = JSON.parse(lines[0]);
  assert.equal(entry1.groupId, "123");
  assert.equal(entry1.thought, "greeting");
  assert.equal(entry1.urge, 8);
  assert.ok(entry1.timestamp);

  const entry2 = JSON.parse(lines[1]);
  assert.equal(entry2.silent, true);

  fs.rmSync(tmpDir, { recursive: true });
});

test("ShadowLogger creates directory if it does not exist", () => {
  const tmpDir = path.join(os.tmpdir(), `shadow-test-${Date.now()}`);
  const logger = new ShadowLogger(tmpDir);

  logger.log({
    groupId: "456",
    phase: "search",
    newMessages: [],
    thought: "test",
    urge: 5,
    silent: true,
    actions: [],
    search: { query: "test", hint: "general", intent: "test" },
  });

  assert.ok(fs.existsSync(path.join(tmpDir, "456.jsonl")));

  fs.rmSync(tmpDir, { recursive: true });
});
```

**Step 2: Run test to verify it fails**

Run: `cd E:\danmaku\next-danmaku-bot\external\mio && npx tsx --test test/shadow-logger.test.ts`
Expected: FAIL — `ShadowLogger` not found.

**Step 3: Write the implementation**

Create `src/shadow-logger.ts`:

```ts
import * as fs from "fs";
import * as path from "path";
import type { Action, SearchRequest } from "./types/response";

export interface ShadowLogInput {
  groupId: string;
  phase: "main" | "search";
  newMessages: { sender: string; content: string }[];
  thought: string;
  urge: number;
  silent: boolean;
  actions: Action[] | null;
  search: SearchRequest | null;
}

export class ShadowLogger {
  private dir: string;
  private initialized = false;

  constructor(dir: string) {
    this.dir = dir;
  }

  log(entry: ShadowLogInput): void {
    if (!this.initialized) {
      fs.mkdirSync(this.dir, { recursive: true });
      this.initialized = true;
    }

    const record = {
      timestamp: new Date().toISOString(),
      ...entry,
    };

    const filePath = path.join(this.dir, `${entry.groupId}.jsonl`);
    fs.appendFileSync(filePath, JSON.stringify(record) + "\n");
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd E:\danmaku\next-danmaku-bot\external\mio && npx tsx --test test/shadow-logger.test.ts`
Expected: Both tests PASS.

---

### Task 3: Wire shadow mode into conversation runtime

**Files:**
- Modify: `src/runtime/conversation.ts`
- Modify: `src/runtime/types.ts` (add `shadowLogger` to `RuntimeDeps`)

**Step 1: Add `ShadowLogger` to `RuntimeDeps`**

In `src/runtime/types.ts`, add import and field:

```ts
import { ShadowLogger } from "../shadow-logger";
```

Add to `RuntimeDeps` interface (after line 44):

```ts
shadowLogger: ShadowLogger | null;
```

**Step 2: Wire `shadowLogger` in `createConversationRuntime`**

In `src/runtime/conversation.ts`, destructure `shadowLogger` from `deps` (add to the destructure block at line 21-33).

**Step 3: Add shadow mode interception in `processConversation`**

In `src/runtime/conversation.ts`, after `validateResponse` and the debug logging (after line 563), add:

```ts
// Shadow mode: log and skip all actions
if (shadowLogger && config.shadowGroups.includes(groupId)) {
  const messageSummary = newMessages.map((m) => ({
    sender: m.sender,
    content: m.segments.map((s) => s.content || `[${s.type}]`).join(""),
  }));
  shadowLogger.log({
    groupId,
    phase: "main",
    newMessages: messageSummary,
    thought: parsedResponse.thought,
    urge: parsedResponse.urge ?? -1,
    silent: parsedResponse.silent,
    actions: parsedResponse.actions || null,
    search: parsedResponse.search || null,
  });
  logger.debug(`[${groupId}] [shadow] 已记录 LLM 响应 (urge=${parsedResponse.urge}, silent=${parsedResponse.silent})`);
  if (newMessages.length > 0) {
    state.lastRespondedAt.set(groupId, newMessages[newMessages.length - 1].timestamp);
  }
  return;
}
```

**Step 4: Add shadow mode interception in `handleSearch`**

In `src/runtime/conversation.ts`, inside `handleSearch`, after the search follow-up LLM response is parsed and validated (after line 402, before the `if (!parsedResponse.silent ...)` block), add:

```ts
if (shadowLogger && config.shadowGroups.includes(groupId)) {
  const messageSummary = originalNewMessages.map((m) => ({
    sender: m.sender,
    content: m.segments.map((s) => s.content || `[${s.type}]`).join(""),
  }));
  shadowLogger.log({
    groupId,
    phase: "search",
    newMessages: messageSummary,
    thought: parsedResponse.thought,
    urge: parsedResponse.urge ?? -1,
    silent: parsedResponse.silent,
    actions: parsedResponse.actions || null,
    search: null,
  });
  logger.debug(`[${groupId}] [shadow] 已记录搜索后 LLM 响应`);
  if (originalNewMessages.length > 0) {
    state.lastRespondedAt.set(groupId, originalNewMessages[originalNewMessages.length - 1].timestamp);
  }
  return;
}
```

**Step 5: Verify build**

Run: `cd E:\danmaku\next-danmaku-bot && yarn build`
Expected: Build fails — `shadowLogger` is not provided at the call site yet. That's expected, we fix it in Task 4.

---

### Task 4: Wire `ShadowLogger` at plugin initialization

**Files:**
- Modify: the file that calls `createConversationRuntime()` to pass `shadowLogger`

**Step 1: Find the call site**

Search for `createConversationRuntime` usage in the codebase (likely `src/index.tsx` or a runtime setup file).

**Step 2: Create and pass `ShadowLogger` instance**

```ts
import { ShadowLogger } from "./shadow-logger";

// Where RuntimeDeps is assembled:
const shadowLogger = config.shadowGroups.length > 0
  ? new ShadowLogger(path.resolve(ctx.baseDir, "data/shadow"))
  : null;
```

Pass `shadowLogger` in the deps object.

**Step 3: Verify build**

Run: `cd E:\danmaku\next-danmaku-bot && yarn build`
Expected: Build succeeds.

**Step 4: Run all tests**

Run: `cd E:\danmaku\next-danmaku-bot\external\mio && npx tsx --test test/*.test.ts`
Expected: All tests pass.

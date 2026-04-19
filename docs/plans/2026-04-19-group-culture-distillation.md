# Group Culture Distillation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign `groupCulture` so raw cultural observations are stored as evidence, promoted into canonical group facts by a dedicated distillation step, and injected into prompts as deduplicated representative items.

**Architecture:** Add a new `mio.culture_evidence` table as the fast-write evidence layer, repurpose culture ingestion to write there, and extend the daily distillation pipeline with a dedicated `maintainGroupCulture()` step that clusters evidence and updates canonical `subject="group"` semantic facts. Then tighten the read path so prompt injection only reads canonical culture items with per-kind caps and final deduplication.

**Tech Stack:** TypeScript, Koishi model/database tables, existing `EmbeddingService`, existing `LLMClient`, Node.js built-in test runner, yarn, TypeScript build via `yarn build`

---

### Task 1: Add the culture evidence schema

**Files:**
- Modify: `src/memory/tables.ts`
- Modify: `src/memory/types.ts`
- Test: `test/group-culture-distillation.test.ts`

**Step 1: Write the failing test**

Add a new test file `test/group-culture-distillation.test.ts` that imports the table/type helpers you need and asserts the new evidence row shape is supported by the code path you are about to add.

Start with a small shape test for a `MioCultureEvidenceRow` fixture and a placeholder assertion that fails because the type or table does not exist yet.

**Step 2: Run test to verify it fails**

Run:

```powershell
node --test test/group-culture-distillation.test.ts
```

Expected: FAIL because `MioCultureEvidenceRow` or the new table definition does not exist yet.

**Step 3: Write minimal implementation**

In `src/memory/tables.ts`:

- extend the Koishi `Tables` declaration with `mio.culture_evidence`
- add a `MioCultureEvidenceRow` interface
- extend the model with the new table

In `src/memory/types.ts`:

- add shared culture-canon kinds if needed
- add helper types for evidence rows and future clustering inputs

Prefer these fields:

- `id`
- `groupId`
- `kind`
- `content`
- `embedding`
- `confidence`
- `sourceEpisodeId`
- `sourceWindowKey`
- `observedAt`
- `lastSeenAt`
- `status`
- `clusterId`

**Step 4: Run test to verify it passes**

Run:

```powershell
node --test test/group-culture-distillation.test.ts
```

Expected: PASS for the schema/type assertions.

**Step 5: Commit**

```powershell
git add test/group-culture-distillation.test.ts src/memory/tables.ts src/memory/types.ts
git commit -m "feat(memory): add culture evidence schema"
```

### Task 2: Redirect culture ingestion into the evidence layer

**Files:**
- Modify: `src/memory/culture-learning.ts`
- Modify: `src/memory/index.ts`
- Test: `test/group-culture-distillation.test.ts`

**Step 1: Write the failing test**

Add a test that feeds a couple of `cultural_observations` into the culture ingestion path and expects:

- rows are written to `mio.culture_evidence`
- direct `subject="group"` semantic writes do not happen in this path
- extraction `meme` is normalized to `inside_joke`

Keep the test small and use a fake or in-memory database stub consistent with the existing test style.

**Step 2: Run test to verify it fails**

Run:

```powershell
node --test test/group-culture-distillation.test.ts
```

Expected: FAIL because the ingestion path still writes directly to `mio.semantic`.

**Step 3: Write minimal implementation**

In `src/memory/culture-learning.ts`:

- replace direct canon writes with evidence writes
- keep embedding generation
- keep only very-close duplicate suppression for the same batch or window
- normalize extraction `meme` to `inside_joke`

In `src/memory/index.ts`:

- keep the `record()` call flow intact
- continue collecting `culturalSummaries`, but base them on evidence ingestion results

**Step 4: Run test to verify it passes**

Run:

```powershell
node --test test/group-culture-distillation.test.ts
```

Expected: PASS for evidence-ingestion behavior.

**Step 5: Commit**

```powershell
git add test/group-culture-distillation.test.ts src/memory/culture-learning.ts src/memory/index.ts
git commit -m "feat(memory): store culture observations as evidence"
```

### Task 3: Add evidence clustering helpers for culture distillation

**Files:**
- Modify: `src/memory/distillation.ts`
- Modify: `src/memory/types.ts`
- Test: `test/group-culture-distillation.test.ts`

**Step 1: Write the failing test**

Add focused tests for pure helper behavior:

- evidence from the same `sourceWindowKey` should not count like independent support
- similar evidence of the same kind should cluster together
- different kinds should never cluster together

Keep these tests as deterministic helper-level tests without calling the LLM.

**Step 2: Run test to verify it fails**

Run:

```powershell
node --test test/group-culture-distillation.test.ts
```

Expected: FAIL because the clustering or support-scoring helpers do not exist yet.

**Step 3: Write minimal implementation**

In `src/memory/distillation.ts`:

- add helper functions for:
  - loading recent evidence
  - bucketing by kind
  - clustering by embedding similarity
  - computing support from count, distinct days, distinct windows, average confidence, and recency

In `src/memory/types.ts`:

- add small internal types for cluster inputs and scoring outputs if they improve clarity

Keep the first pass simple and deterministic.

**Step 4: Run test to verify it passes**

Run:

```powershell
node --test test/group-culture-distillation.test.ts
```

Expected: PASS for the helper behavior.

**Step 5: Commit**

```powershell
git add test/group-culture-distillation.test.ts src/memory/distillation.ts src/memory/types.ts
git commit -m "feat(memory): add culture evidence clustering helpers"
```

### Task 4: Add dedicated group culture canonicalization and promotion

**Files:**
- Modify: `src/memory/distillation.ts`
- Modify: `data/prompts.yaml`
- Test: `test/group-culture-distillation.test.ts`

**Step 1: Write the failing test**

Add a test that seeds recent evidence representing one repeated pattern and expects the new group-culture distillation step to produce only one canonical `subject="group"` semantic item.

Include a case where several evidence lines are near-duplicates of the same idea.

**Step 2: Run test to verify it fails**

Run:

```powershell
node --test test/group-culture-distillation.test.ts
```

Expected: FAIL because there is no dedicated culture distillation step or canonicalization prompt yet.

**Step 3: Write minimal implementation**

In `data/prompts.yaml`:

- add a narrow prompt dedicated to culture cluster canonicalization

In `src/memory/distillation.ts`:

- add `maintainGroupCulture(groupId)`
- load candidate groups from the union of relational, episodic, semantic-group, and culture-evidence sources
- canonicalize each promotable cluster through the LLM
- promote, merge, confirm, or decay canonical `subject="group"` semantic rows

Do not mix this step into the generic semantic prompt; keep it explicit and debuggable.

**Step 4: Run test to verify it passes**

Run:

```powershell
node --test test/group-culture-distillation.test.ts
```

Expected: PASS with one canonical item created or updated for one repeated pattern.

**Step 5: Commit**

```powershell
git add test/group-culture-distillation.test.ts data/prompts.yaml src/memory/distillation.ts
git commit -m "feat(memory): distill culture evidence into canonical group facts"
```

### Task 5: Tighten prompt injection to canonical group culture only

**Files:**
- Modify: `src/memory/context-assembler.ts`
- Test: `test/group-culture-distillation.test.ts`

**Step 1: Write the failing test**

Add a test that seeds several canonical group facts and verifies:

- only canonical items are returned
- similar canon items are deduplicated
- per-kind caps are respected
- the final output stays within the intended `8-15` item range

Use deterministic embeddings or test doubles if needed.

**Step 2: Run test to verify it fails**

Run:

```powershell
node --test test/group-culture-distillation.test.ts
```

Expected: FAIL because the current read path only sorts by confidence and slices.

**Step 3: Write minimal implementation**

In `src/memory/context-assembler.ts`:

- update `buildGroupCulture()` so it reads only canonical group rows
- add final lightweight deduplication
- apply per-kind caps
- sort by confidence plus recency, not confidence alone

Keep the text format unchanged: one line per injected item with `- ` prefix.

**Step 4: Run test to verify it passes**

Run:

```powershell
node --test test/group-culture-distillation.test.ts
```

Expected: PASS for canonical-only prompt injection.

**Step 5: Commit**

```powershell
git add test/group-culture-distillation.test.ts src/memory/context-assembler.ts
git commit -m "feat(prompt): inject canonical group culture only"
```

### Task 6: Add legacy compatibility cleanup for existing duplicate group facts

**Files:**
- Modify: `src/memory/distillation.ts`
- Test: `test/group-culture-distillation.test.ts`

**Step 1: Write the failing test**

Add a test that seeds several legacy `subject="group"` semantic rows with overlapping meanings and verifies the culture maintenance step merges or suppresses duplicates instead of continuing to surface all of them.

**Step 2: Run test to verify it fails**

Run:

```powershell
node --test test/group-culture-distillation.test.ts
```

Expected: FAIL because legacy canon rows are not yet merged or decayed by the new path.

**Step 3: Write minimal implementation**

In `src/memory/distillation.ts`:

- allow culture clusters to merge into existing legacy group canon rows
- add a cleanup rule that decays or supersedes near-duplicate canonical group facts
- keep the logic narrow to group culture only

This should reduce noisy historical duplicates without requiring a risky one-shot migration.

**Step 4: Run test to verify it passes**

Run:

```powershell
node --test test/group-culture-distillation.test.ts
```

Expected: PASS with legacy duplicate behavior controlled.

**Step 5: Commit**

```powershell
git add test/group-culture-distillation.test.ts src/memory/distillation.ts
git commit -m "feat(memory): clean up legacy group culture duplicates"
```

### Task 7: Verify end-to-end behavior and build

**Files:**
- Modify: `test/group-culture-distillation.test.ts`
- Verify: `src/memory/culture-learning.ts`
- Verify: `src/memory/distillation.ts`
- Verify: `src/memory/context-assembler.ts`
- Verify: `data/prompts.yaml`

**Step 1: Add or tighten final integration assertions**

In `test/group-culture-distillation.test.ts`, add one end-to-end-style case covering:

- repeated `/选` evidence becoming one tool-knowledge item
- repeated "问号/草/强强" evidence becoming one reaction-pattern item
- a concrete example such as `/选劳拉西泮还是盐酸氟西汀` not surfacing as its own injected rule

**Step 2: Run the focused test suite**

Run:

```powershell
node --test test/group-culture-distillation.test.ts
```

Expected: PASS

**Step 3: Run the existing test suite**

Run:

```powershell
node --test test/*.test.ts
```

Expected: PASS

**Step 4: Run the plugin build**

Run from the plugin repo:

```powershell
yarn build
```

Expected: TypeScript build succeeds.

**Step 5: Run the whole bot build**

Run from the bot project root:

```powershell
Set-Location ..\\..
yarn build
```

Expected: whole-project build succeeds.

**Step 6: Commit**

```powershell
git add test/group-culture-distillation.test.ts src/memory/culture-learning.ts src/memory/distillation.ts src/memory/context-assembler.ts data/prompts.yaml
git commit -m "feat(memory): redesign group culture distillation"
```

# Group Culture Distillation Redesign

**Status:** Approved design

**Problem**

The current `groupCulture` pipeline writes raw `cultural_observations` directly into `mio.semantic` and injects them into the chat system prompt once confidence is high enough. This makes learning fast, but it also mixes together:

- raw observations
- stable culture rules
- concrete examples
- near-duplicate phrasings

As a result, prompt injection becomes noisy and repetitive. Similar facts such as "大家会刷问号", "大家会刷强强！？", and "有人发离谱截图大家会刷草" can all survive as separate items even when they describe the same underlying reaction pattern.

## Goals

- Keep culture learning fast: the first observation should still be stored immediately.
- Make prompt injection medium-density and stable: around `8-15` canonical items.
- Ensure one culture pattern is injected at most once.
- Keep concrete examples as evidence, not injected prompt text.
- Allow culture items to strengthen, evolve, and decay over time.

## Non-Goals

- Rebuilding the whole memory system.
- Replacing the existing episodic or relational pipeline.
- Making `groupCulture` extremely sparse or extremely detailed.

## Current Failure Modes

1. `cultural_observations` are written directly into `mio.semantic`, so provisional observations become prompt-visible too early.
2. Daily semantic distillation confirms group culture using recent episodic summaries, but many culture signals come from low-stakes chat that never becomes episodic memory.
3. Similar group facts are not normalized into a canonical representation before injection.
4. Multiple concrete examples of a tool or joke can survive as separate prompt items.
5. Distillation only iterates groups seen in `mio.relational`, so a group with only culture evidence may never get distilled.

## High-Level Design

Split group culture into two layers:

1. **Culture Evidence Layer**
   Stores raw cultural observations quickly and cheaply.
   This layer is allowed to be noisy and redundant.

2. **Culture Canon Layer**
   Stores normalized, stable culture items that are safe to inject into prompts.
   This layer is sparse, deduplicated, and maintained by a dedicated daily distillation step.

The key design principle is:

> Learn fast, inject slow.

The system should remember early signals immediately, but only expose them to the main chat model after they survive clustering and confirmation.

## Data Model

### New Table: `mio.culture_evidence`

Purpose: store raw `cultural_observations` before promotion into stable canon.

Suggested fields:

- `id: number`
- `groupId: string`
- `kind: string`
  Allowed values: `group_expression | reaction_pattern | tool_knowledge | inside_joke`
- `content: text`
  Raw observation text from extraction
- `embedding: number[]`
- `confidence: number`
- `sourceEpisodeId: number | null`
  Optional link when extraction also created an episodic item
- `sourceWindowKey: string`
  Lightweight fingerprint for the message chunk or conversation window
- `observedAt: number`
- `lastSeenAt: number`
- `status: string`
  Allowed values: `active | promoted | ignored`
- `clusterId: string | null`

### Existing Table: `mio.semantic`

Keep using `mio.semantic` with `subject="group"` as the **canon layer** only.

After the redesign, group-level semantic facts should mean:

- normalized
- stable enough for prompt injection
- maintained via dedicated culture distillation

Raw `cultural_observations` should no longer be written here directly.

## Evidence Ingestion

### Extraction

Keep the existing extraction behavior:

- `extractMemories()` still returns `cultural_observations`
- prompt guidance still allows the model to notice expressions, reaction patterns, tool use, and inside jokes

This preserves learning speed.

### Ingestion Rule

`processCulturalObservations()` should be repurposed:

- map extraction `meme` to canonical evidence kind `inside_joke`
- generate embeddings
- write one row per observation into `mio.culture_evidence`
- avoid only exact or extremely-close duplicate spam from the same chunk

Important change:

- do **not** directly create `subject="group"` semantic facts during evidence ingestion

This means first sightings are remembered, but not yet injected.

## Dedicated Group Culture Distillation

Add a new daily step such as `maintainGroupCulture(groupId)` inside the distillation pipeline.

This step should run for group ids found from the union of:

- `mio.relational`
- `mio.episodic`
- `mio.semantic` where `subject="group"`
- `mio.culture_evidence`

This fixes the current blind spot where a group with only culture evidence is skipped.

### Input Window

Use recent active evidence from roughly the last `30` days as the main source.

This is better than relying on episodic summaries because many cultural signals never become episodic memories.

### Bucketing

Group evidence by `kind` first:

- `group_expression`
- `reaction_pattern`
- `tool_knowledge`
- `inside_joke`

Then cluster within each kind using embedding similarity.

### Clustering

Each cluster should represent one candidate culture pattern.

Cluster signals should include:

- count of evidence rows
- number of distinct days
- number of distinct `sourceWindowKey` values
- average confidence
- recency of last occurrence

This avoids treating one burst of same-session repetition as strong proof.

### Support Score

Compute a simple weighted support score, for example:

- evidence count
- distinct time slices
- distinct windows
- mean confidence
- recency bonus

The exact formula can stay simple. The important property is:

- three independent weak sightings beat five same-window duplicates

### Promotion Policy

A cluster becomes eligible for promotion when it has enough support.

Suggested behavior:

- `tool_knowledge`: lower threshold, because bot commands are usually stable
- `reaction_pattern`: medium threshold
- `group_expression`: medium threshold
- `inside_joke`: slightly higher threshold, because one-off funny events are easy to overfit

The system does not need a fixed global threshold hardcoded in the design, but it should use these category-specific biases.

## Canonicalization

For each candidate cluster, run a narrow LLM task that only does canonicalization, not open-ended memory generation.

### Input

- cluster kind
- `3-8` representative evidence lines
- occurrence counts and dates
- existing matching canon item, if any

### Output

- `canonical_type`
- `canonical_content`
- `should_promote`
- `should_merge_into_existing`
- `reason`
- optional `examples`

### Canonical Text Rules

The canonical text should:

- be at most `32-40` Chinese characters
- describe the stable pattern, not a one-off example
- prefer "trigger + typical reaction" for reaction patterns
- avoid user names unless the name is inseparable from the joke itself
- merge synonymous reactions into one representative line

Examples:

- Good: `群里看到离谱或很强的内容，常会刷问号、草、强强！？`
- Bad: `有人发雀魂和牌截图，大家会发问号`
- Bad: `有人发离谱截图大家会刷卧槽或者草`
- Bad: `群里看到厉害的东西会刷？！强强！？`

The last three are evidence or variants, not canon.

## Canon Maintenance

The distillation step should maintain canon items in three ways:

### Promote

Create a new `mio.semantic` group fact when a cluster is strong enough and does not match an existing canon item.

### Merge / Confirm

If a cluster matches an existing canon item:

- update `confidence`
- update `lastConfirmed`
- optionally rewrite the content if the new canonical text is clearly better

### Decay

If a canon item has no matching evidence for a long time:

- reduce confidence gradually
- once confidence falls below the injection threshold, it stops appearing in `groupCulture`

This keeps stale group habits from staying forever.

## Read Path and Prompt Injection

`ContextAssembler.buildGroupCulture()` should change from:

- read all active group facts with `confidence >= 0.4`
- sort by confidence
- top `15`

to a more constrained display rule:

- read **canon only**
- apply a final lightweight dedup by embedding similarity
- cap items by kind to avoid one category flooding the list
- sort by confidence and recency together
- inject `8-15` items total

Suggested per-kind caps:

- `reaction_pattern`: max `4`
- `group_expression`: max `3`
- `tool_knowledge`: max `3`
- `inside_joke`: max `3`

This helps keep the prompt varied and readable.

## Migration Strategy

Existing `subject="group"` semantic rows already contain mixed-quality data. We need a one-time migration strategy.

Recommended migration:

1. Leave historical group semantic rows in place initially.
2. Add the new evidence table and new distillation path.
3. During the first few distillation runs:
   - treat old group semantic rows as legacy canon
   - allow new evidence clusters to merge into them
4. Once the new pipeline is stable:
   - optionally run a cleanup pass that merges or archives near-duplicate legacy canon rows

This avoids breaking the current system abruptly.

## Testing Strategy

### Unit / Behavior Tests

Add tests for:

- evidence ingestion writes `mio.culture_evidence` instead of direct group semantic rows
- clustering keeps same-window spam from over-counting
- similar evidence promotes one canonical item instead of several near-duplicates
- tool knowledge and reaction patterns are promoted independently
- `buildGroupCulture()` returns only canonical rows and respects per-kind caps

### Integration Checks

Use a seeded fake dataset to verify:

- repeated `/选` observations become one tool-knowledge item
- multiple "问号/草/强强" observations become one reaction-pattern item
- a specific example like `/选劳拉西泮还是盐酸氟西汀` does not appear as its own injected rule

## Risks and Mitigations

### Risk: Canonicalization becomes too conservative

Mitigation:

- evidence is still stored immediately
- lower thresholds for `tool_knowledge`
- use recency and distinct-window support instead of only raw counts

### Risk: LLM canonicalization hallucinates or over-generalizes

Mitigation:

- keep the prompt narrow
- provide only cluster evidence, not the full memory world
- constrain output length and style heavily

### Risk: Legacy duplicates remain visible too long

Mitigation:

- add a final dedup pass during `buildGroupCulture()`
- allow first migration runs to merge legacy canon rows

## Result

After this redesign:

- culture learning remains fast
- prompt injection becomes medium-density and stable
- duplicate observations stop surfacing as multiple prompt lines
- examples remain as evidence, while canon becomes the only source of `groupCulture`

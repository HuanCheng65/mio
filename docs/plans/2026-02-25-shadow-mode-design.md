# Shadow Mode Design

## Overview

Shadow mode allows the bot to run silently in specific groups — processing messages and running LLM inference as normal, but suppressing all outgoing actions (messages, replies, reactions, stickers, recalls). The complete LLM decision (thought, urge, actions) is logged to a JSONL file for offline observation.

Analogous to "shadow mode" in autonomous driving: the system runs but doesn't actuate.

## Requirements

- LLM inference runs normally; only action execution is suppressed
- JSONL log format, one file per group: `data/shadow/{groupId}.jsonl`
- Per-group configuration via `shadowGroups: string[]` in config
- Both "speak" and "silent" decisions are logged
- Search follow-up responses are also logged
- Memory, buffer, debounce, and rate limiting continue as normal

## Design

### Config

Add `shadowGroups: string[]` alongside `enableGroups` in `Config`:

```ts
shadowGroups: string[];  // groups in shadow mode
```

A group can be in both `enableGroups` and `shadowGroups` — enabled but output-suppressed.

### Shadow Logger (`src/shadow-logger.ts`)

Single-responsibility module: append structured records to JSONL files.

```ts
interface ShadowLogEntry {
  timestamp: string;        // ISO 8601
  groupId: string;
  phase: "main" | "search"; // which LLM round
  newMessages: { sender: string; content: string }[];
  thought: string;
  urge: number;
  silent: boolean;
  actions: Action[] | null;
  search: SearchRequest | null;
}
```

- File path: `data/shadow/{groupId}.jsonl`
- Creates directory on first write
- Uses `fs.appendFileSync` for simplicity (log writes are small and infrequent)

### Interception Points

**In `processConversation`** (after LLM response is parsed, ~line 560):
- If group is in `shadowGroups`, log the full parsed response
- Skip action execution, search handling, and state updates
- Still advance `lastRespondedAt` pointer to avoid reprocessing

**In `handleSearch`** (after search follow-up LLM response is parsed, ~line 397):
- Same pattern: log and skip

**`executeActions` itself is NOT modified** — interception happens upstream.

### JSONL Record Example

```json
{"timestamp":"2026-02-25T14:30:00Z","groupId":"123456","phase":"main","newMessages":[{"sender":"Alice","content":"今天天气真好"}],"thought":"天气话题，可以聊两句","urge":8,"silent":false,"actions":[{"type":"message","content":"确实不错呢"}],"search":null}
```

### What Stays The Same

- Rate limit / cooldown / debounce logic unchanged
- Memory system runs normally
- Message buffer collects normally
- Only final action execution is suppressed

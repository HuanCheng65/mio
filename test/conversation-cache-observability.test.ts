import test from "node:test";
import assert from "node:assert/strict";
import { formatConversationCacheLog } from "../src/llm/token-tracker";

test("formatConversationCacheLog includes persona and cache hit metadata", () => {
  const line = formatConversationCacheLog({
    personaId: "default",
    personaName: "澪",
    personaHash: "abcdef123456",
    cacheHitSource: "explicit",
    cachedTokens: 6054,
    cacheName: "cachedContents/123",
  });

  assert.match(line, /persona=default/);
  assert.match(line, /personaName=澪/);
  assert.match(line, /personaHash=abcdef12/);
  assert.match(line, /cache=explicit/);
  assert.match(line, /6054/);
  assert.match(line, /cacheName=cachedContents\/123/);
});

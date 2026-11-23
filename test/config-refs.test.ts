import test from "node:test";
import assert from "node:assert/strict";
import { restoreRefs, type ChangedRef } from "../src/console/config-refs";

const raw = {
  providers: [
    { id: "deepseek", apiKey: "${{ env.DEEPSEEK_API_KEY }}", baseUrl: "https://api.deepseek.com" },
    { id: "claude", apiKey: "${{ env.ANTHROPIC_API_KEY }}" },
  ],
  search: { saucenaoApiKey: "plain" },
};
const resolved = {
  providers: [
    { id: "deepseek", apiKey: "sk-ds", baseUrl: "https://api.deepseek.com" },
    { id: "claude", apiKey: "sk-ant" },
  ],
  search: { saucenaoApiKey: "plain", enabled: true },
};

test("unchanged values keep their env references", () => {
  const next = structuredClone(resolved);
  next.search.enabled = false;
  const changed: ChangedRef[] = [];
  assert.deepEqual(restoreRefs(raw, resolved, next, changed), {
    providers: raw.providers,
    search: { saucenaoApiKey: "plain", enabled: false },
  });
  assert.deepEqual(changed, []);
});

test("an edited referenced value is written as the new value and reported", () => {
  const next = structuredClone(resolved);
  next.providers[1].apiKey = "sk-new";
  const changed: ChangedRef[] = [];
  const out = restoreRefs(raw, resolved, next, changed) as typeof raw;
  assert.equal(out.providers[0].apiKey, "${{ env.DEEPSEEK_API_KEY }}");
  assert.equal(out.providers[1].apiKey, "sk-new");
  assert.deepEqual(changed, [{ path: "/providers/1/apiKey", ref: "${{ env.ANTHROPIC_API_KEY }}" }]);
});

test("providers are matched by id when reordered, removed or added", () => {
  const next = {
    providers: [
      { id: "new", apiKey: "sk-x" },
      { id: "claude", apiKey: "sk-ant" },
    ],
  };
  assert.deepEqual(restoreRefs(raw, resolved, next), {
    providers: [
      { id: "new", apiKey: "sk-x" },
      { id: "claude", apiKey: "${{ env.ANTHROPIC_API_KEY }}" },
    ],
  });
});

test("a referenced provider whose id was renamed loses its reference", () => {
  const next = { providers: [{ id: "deepseek2", apiKey: "sk-ds", baseUrl: "https://api.deepseek.com" }] };
  assert.deepEqual(restoreRefs(raw, resolved, next), next);
});

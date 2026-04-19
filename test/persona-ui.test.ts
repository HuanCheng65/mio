import test from "node:test";
import assert from "node:assert/strict";
import { buildDeletePersonaWarning, summarizePersonaRow } from "../client/persona-ui";

test("buildDeletePersonaWarning includes fallback impact wording", () => {
  const text = buildDeletePersonaWarning("澪-alt", ["123", "456"]);

  assert.match(text, /恢复到默认/);
  assert.match(text, /2 个群/);
  assert.match(text, /澪-alt/);
});

test("summarizePersonaRow highlights default badge, binding count, and recency", () => {
  const summary = summarizePersonaRow({
    name: "澪",
    isDefault: true,
    boundGroupCount: 2,
    updatedAt: Date.UTC(2026, 3, 20, 0, 0, 0),
  }, Date.UTC(2026, 3, 20, 1, 0, 0));

  assert.deepEqual(summary.badges, ["默认"]);
  assert.match(summary.meta, /2 个群/);
  assert.match(summary.meta, /1 小时前/);
});

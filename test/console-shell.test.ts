import test from "node:test";
import assert from "node:assert/strict";
import { createConsoleSections, DEFAULT_CONSOLE_SECTION } from "../client/console-shell";

test("console shell opens on the config studio so a broken config can be fixed first", () => {
  const sections = createConsoleSections();

  assert.equal(DEFAULT_CONSOLE_SECTION, "config");
  assert.deepEqual(sections.map((section) => section.id), [
    "config",
    "persona",
    "runtime",
    "maintenance",
  ]);
  assert.equal(sections[0].label, "模型配置");
});

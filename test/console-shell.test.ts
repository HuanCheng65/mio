import test from "node:test";
import assert from "node:assert/strict";
import { createConsoleSections, DEFAULT_CONSOLE_SECTION } from "../client/console-shell";

test("console shell uses persona workspace as the default primary section", () => {
  const sections = createConsoleSections();

  assert.equal(DEFAULT_CONSOLE_SECTION, "persona");
  assert.deepEqual(sections.map((section) => section.id), [
    "persona",
    "runtime",
    "maintenance",
  ]);
  assert.equal(sections[0].label, "人设工作区");
});

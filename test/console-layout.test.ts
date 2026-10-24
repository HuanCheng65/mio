import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("workspace body stays structural instead of rendering a second card surface", () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(resolve(testDir, "..", "client", "page.vue"), "utf8");

  const workspaceBodyBlock = source.match(/\.workspace-body\s*\{([\s\S]*?)\n\}/);

  assert.ok(workspaceBodyBlock, "expected .workspace-body style block to exist");
  assert.doesNotMatch(workspaceBodyBlock[1], /background\s*:/);
  assert.doesNotMatch(workspaceBodyBlock[1], /border-radius\s*:/);
  assert.doesNotMatch(workspaceBodyBlock[1], /box-shadow\s*:/);
});

test("runtime tables render inside an explicit overflow shell", () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(resolve(testDir, "..", "client", "components", "runtime-overview-panel.vue"), "utf8");

  assert.match(source, /class="table-scroll"/);
  assert.match(source, /\.table-scroll\s*\{[^}]*overflow-x:\s*auto;/);
});

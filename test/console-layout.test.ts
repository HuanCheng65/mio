import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("workspace panel stays structural instead of rendering a second card surface", () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(resolve(testDir, "..", "client", "page.vue"), "utf8");

  const workspacePanelBlock = source.match(/\.workspace-panel\s*\{([\s\S]*?)\n\}/);

  assert.ok(workspacePanelBlock, "expected .workspace-panel style block to exist");
  assert.doesNotMatch(workspacePanelBlock[1], /background\s*:/);
  assert.doesNotMatch(workspacePanelBlock[1], /border-radius\s*:/);
  assert.doesNotMatch(workspacePanelBlock[1], /box-shadow\s*:/);
  assert.doesNotMatch(workspacePanelBlock[1], /padding\s*:/);
});

test("runtime tables render inside an explicit overflow shell", () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(resolve(testDir, "..", "client", "components", "runtime-overview-panel.vue"), "utf8");

  assert.match(source, /class="runtime-table-shell"/);
  assert.match(source, /\.runtime-table-shell\s*\{[\s\S]*overflow:\s*auto;/);
});

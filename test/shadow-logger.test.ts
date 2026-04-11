import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ShadowLogger } from "../src/shadow-logger";

test("ShadowLogger writes JSONL entries to per-group files", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-test-"));
  const logger = new ShadowLogger(tmpDir);

  logger.log({
    groupId: "123",
    phase: "main",
    newMessages: [{ sender: "Alice", content: "hello" }],
    thought: "greeting",
    urge: 8,
    silent: false,
    actions: [{ type: "message", content: "hi" }],
    search: null,
  });

  logger.log({
    groupId: "123",
    phase: "main",
    newMessages: [{ sender: "Bob", content: "bye" }],
    thought: "farewell",
    urge: 3,
    silent: true,
    actions: [],
    search: null,
  });

  const filePath = path.join(tmpDir, "123.jsonl");
  assert.ok(fs.existsSync(filePath));

  const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
  assert.equal(lines.length, 2);

  const entry1 = JSON.parse(lines[0]);
  assert.equal(entry1.groupId, "123");
  assert.equal(entry1.thought, "greeting");
  assert.equal(entry1.urge, 8);
  assert.ok(entry1.timestamp);

  const entry2 = JSON.parse(lines[1]);
  assert.equal(entry2.silent, true);

  fs.rmSync(tmpDir, { recursive: true });
});

test("ShadowLogger creates directory if it does not exist", () => {
  const tmpDir = path.join(os.tmpdir(), `shadow-test-${Date.now()}`);
  const logger = new ShadowLogger(tmpDir);

  logger.log({
    groupId: "456",
    phase: "search",
    newMessages: [],
    thought: "test",
    urge: 5,
    silent: true,
    actions: [],
    search: { query: "test", hint: "general", intent: "test" },
  });

  assert.ok(fs.existsSync(path.join(tmpDir, "456.jsonl")));

  fs.rmSync(tmpDir, { recursive: true });
});

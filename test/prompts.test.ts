import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Context } from "koishi";
import sqlite from "@koishijs/plugin-database-sqlite";
import { DATA_DIR } from "../src/paths";
import { extendPromptTable, PromptStore } from "../src/agent/prompts";

const seed = (file: string) => readFileSync(join(DATA_DIR, file), "utf8").trim();

async function setup() {
  const app = new Context();
  app.plugin(sqlite, { path: ":memory:" });
  extendPromptTable(app);
  await app.start();
  return { app, store: new PromptStore(app, "mio-agent.md") };
}

test("uses the seed files until something is edited in the database", async () => {
  const { app, store } = await setup();
  assert.throws(() => store.current(), /还没从数据库加载/);

  const prompts = await store.load();
  assert.equal(prompts.systemPrompt, `${seed("persona/mio-agent.md")}\n\n---\n\n${seed("agent/environment.md")}`);
  assert.equal(prompts.reminder, seed("agent/reminder.md"));
  assert.equal(prompts.sleep, seed("agent/sleep.md"));
  assert.deepEqual((await store.list()).map((p) => [p.name, p.seedFile, p.edited]), [
    ["persona", join("persona", "mio-agent.md"), false],
    ["environment", join("agent", "environment.md"), false],
    ["reminder", join("agent", "reminder.md"), false],
    ["sleep", join("agent", "sleep.md"), false],
  ]);
  await app.stop();
});

test("an edit takes effect at once, and saving the seed text or resetting goes back to the file", async () => {
  const { app, store } = await setup();
  await store.load();

  await store.save("reminder", "  〔少说两句〕\n");
  assert.equal(store.current().reminder, "〔少说两句〕");
  const edited = (await store.list()).find((p) => p.name === "reminder")!;
  assert.equal(edited.edited, true);
  assert.equal(edited.seed, seed("agent/reminder.md"));

  await store.save("reminder", seed("agent/reminder.md"));
  assert.equal((await store.list()).find((p) => p.name === "reminder")!.edited, false, "saving the seed text drops the edit");

  await store.save("persona", "我是测试人设");
  assert.match(store.current().systemPrompt, /^我是测试人设\n\n---\n\n/);
  await store.reset("persona");
  assert.equal(store.current().systemPrompt.startsWith(seed("persona/mio-agent.md")), true);

  await assert.rejects(store.save("sleep", "   "), /不能为空/);
  await app.stop();
});

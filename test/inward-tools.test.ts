import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "koishi";
import sqlite from "@koishijs/plugin-database-sqlite";
import { extendEventTable, EventStore } from "../src/agent/event-store";
import { createFindSourceTool, createSearchTool } from "../src/agent/inward-tools";
import type { ToolContext } from "../src/agent/tools";
import type { NormalizedMessage } from "../src/perception/types";

const G = "qq:G";
const ctx: ToolContext = { groupId: G, platform: "qq", shadow: false };

function fakeSearch() {
  const calls: unknown[][] = [];
  return {
    calls,
    async searchText(query: string, kind: string, intent: string) {
      calls.push(["text", query, kind, intent]);
      return query === "没有的东西" ? null : `${query} 是一部作品`;
    },
    async searchImage(image: Buffer, filename: string, intent: string) {
      calls.push(["image", image.length, filename, intent]);
      return "画师是某某";
    },
  };
}

test("search passes the query through and says plainly when nothing was found", async () => {
  const search = fakeSearch();
  const tool = createSearchTool(search as any);
  assert.equal(await tool.run({ query: "Summer Pockets", kind: "galgame", intent: "类型" }, ctx), "Summer Pockets 是一部作品");
  assert.equal(await tool.run({ query: "没有的东西", kind: "general", intent: "是什么" }, ctx), "没搜到关于「没有的东西」的有用信息");
  assert.equal(await tool.run({ query: "x", kind: "movie", intent: "" }, ctx), "kind 只能是 anime / galgame / music / general");
  assert.deepEqual(search.calls[0], ["text", "Summer Pockets", "galgame", "类型"]);
});

test("find_source searches the saved image of a message", async () => {
  const app = new Context();
  app.plugin(sqlite, { path: ":memory:" });
  extendEventTable(app);
  await app.start();
  const events = new EventStore(app);
  const mediaDir = mkdtempSync(join(tmpdir(), "mio-media-"));
  writeFileSync(join(mediaDir, "b.png"), Buffer.from([1, 2, 3]));
  const body: NormalizedMessage = {
    id: "p1", sender: "小林", senderId: "U1", isBot: false, timestamp: Date.now(), mentions: [],
    segments: [
      { type: "image", url: "u1", description: null, isSticker: false },
      { type: "image", url: "u2", description: null, isSticker: false, file: "b.png" },
    ],
  };
  await events.append(G, async () => ({ kind: "message", platformMessageId: "p1", userId: "U1", isBot: false, timestamp: body.timestamp, body }));
  const search = fakeSearch();
  const tool = createFindSourceTool({ events, search: search as any, mediaDir });

  assert.equal(await tool.run({ message: "m1" }, ctx), "这张图当时没能保存下来，查不了");
  assert.equal(await tool.run({ message: "m1", image: 3 }, ctx), "m1 只有 2 张图");
  assert.equal(await tool.run({ message: "m1", image: 2, intent: "画师" }, ctx), "画师是某某");
  assert.deepEqual(search.calls, [["image", 3, "b.png", "画师"]]);
  assert.equal(await tool.run({ message: "m7" }, ctx), "找不到 m7 这条消息");
  await app.stop();
});

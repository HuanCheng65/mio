import test from "node:test";
import assert from "node:assert/strict";
import { PromptBuilder } from "../src/context/prompt-builder";
import { getPromptManager } from "../src/memory/prompt-manager";

test("PromptBuilder exposes stable static core separately from dynamic prompt body", () => {
  const builder = new PromptBuilder("mio.md");
  const core = builder.buildStaticCore({ personaContent: "# persona" });
  const full = builder.buildSystemPrompt({
    personaContent: "# persona",
    userProfile: "- Echo",
  });

  const promptManager = getPromptManager();
  const expectedPrefix = [
    promptManager.getRaw("chat_system_layer0_cognitive"),
    "\n---\n",
    promptManager.getRaw("chat_system_layer1_behavior"),
    "\n---\n",
    promptManager.get("chat_system_layer2_format", {
      allowedReactEmojis: "赞、爱心、太好笑、可怜、捂脸、心碎、流泪、惊讶、拜谢、冷漠、汪汪、菜汪、问号、辣眼睛、变形、我酸了、暗中观察、舔屏、糗大了",
    }),
    "\n---\n",
    "# persona",
  ].join("\n");

  assert.equal(core.text, expectedPrefix);
  assert.equal(full.startsWith(core.text), true);
});

test("PromptBuilder keeps user prompt templated instead of hardcoding prompt text", () => {
  const builder = new PromptBuilder("mio.md");
  const promptManager = getPromptManager();

  const prompt = builder.buildUserPrompt({
    recentMessages: "[m1] hi\n--- 以下是你刚划到的新消息 ---\n[m2] hi again",
    recentBotCount: 2,
  });

  assert.ok(prompt.includes("[m1] hi"));
  assert.ok(prompt.includes("[m2] hi again"));
  assert.ok(prompt.includes("（你最近 5 分钟内说了 2 条消息。）"));
  assert.ok(prompt.includes(promptManager.getRaw("chat_history_prefix").trimEnd()));
  assert.ok(prompt.includes(promptManager.getRaw("chat_anchor").trimEnd()));
});

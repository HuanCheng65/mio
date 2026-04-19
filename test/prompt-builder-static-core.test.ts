import test from "node:test";
import assert from "node:assert/strict";
import { PromptBuilder } from "../src/context/prompt-builder";
import { getPromptManager } from "../src/memory/prompt-manager";

test("PromptBuilder exposes stable static core separately from dynamic prompt body", () => {
  const builder = new PromptBuilder("mio.md");
  const core = builder.buildStaticCore({ personaContent: "# persona" });
  const full = builder.buildSystemPrompt({
    personaContent: "# persona",
    recentMessages: "[m1] hi",
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

  const prompt = builder.buildUserPrompt("见上文标记为 [新消息] 的消息：m7、m8", 2);

  assert.equal(prompt, promptManager.get("chat_user_simple", {
    newMessages: "见上文标记为 [新消息] 的消息：m7、m8",
    recentBotActivity: "（你最近 5 分钟内说了 2 条消息。）\n",
  }));
});

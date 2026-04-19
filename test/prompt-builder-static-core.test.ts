import test from "node:test";
import assert from "node:assert/strict";
import { PromptBuilder } from "../src/context/prompt-builder";

test("PromptBuilder exposes stable static core separately from dynamic prompt body", () => {
  const builder = new PromptBuilder("mio.md");
  const core = builder.buildStaticCore({ personaContent: "# persona" });
  const full = builder.buildSystemPrompt({
    personaContent: "# persona",
    recentMessages: "[m1] hi",
    userProfile: "- Echo",
  });

  assert.match(core.text, /认知框架/);
  assert.equal(full.startsWith(core.text), true);
});

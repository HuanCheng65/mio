import test from "node:test";
import assert from "node:assert/strict";
import { registerAdminCommands } from "../src/runtime/commands";

function createFakeCommandCtx() {
  const actions = new Map<string, (...args: any[]) => any>();

  const ctx = {
    command(name: string) {
      return {
        action(handler: (...args: any[]) => any) {
          actions.set(name, handler);
          return this;
        },
      };
    },
  };

  return { ctx, actions };
}

test("mio.reload invalidates existing Gemini explicit caches after reloading prompts", async () => {
  const { ctx, actions } = createFakeCommandCtx();
  let invalidated = 0;

  registerAdminCommands({
    ctx: ctx as any,
    logger: console,
    config: { enableGroups: [] } as any,
    geminiCacheManager: {
      async invalidateAllCaches() {
        invalidated += 1;
      },
    },
  } as any, {
    botMutedGroups: new Map(),
    activeRequests: new Map(),
    hourlyReplies: new Map(),
  } as any);

  await actions.get("mio.reload")!();

  assert.equal(invalidated, 1);
});

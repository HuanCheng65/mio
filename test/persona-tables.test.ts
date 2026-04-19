import test from "node:test";
import assert from "node:assert/strict";
import { extendPersonaTables } from "../src/persona/types";

test("extendPersonaTables registers persona, binding, and cache tables", () => {
  const extended: string[] = [];
  const ctx = {
    model: {
      extend(name: string) {
        extended.push(name);
      },
    },
  } as any;

  extendPersonaTables(ctx);

  assert.deepEqual(extended.sort(), [
    "mio.gemini_cache",
    "mio.group_persona_binding",
    "mio.persona",
  ]);
});

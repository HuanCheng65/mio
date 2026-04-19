import test from "node:test";
import assert from "node:assert/strict";
import { extendPersonaTables } from "../src/persona/types";

test("extendPersonaTables registers persona, binding, and cache tables", () => {
  const extended: string[] = [];
  const optionsByName = new Map<string, any>();
  const ctx = {
    model: {
      extend(name: string, _fields: any, options: any) {
        extended.push(name);
        optionsByName.set(name, options);
      },
    },
  } as any;

  extendPersonaTables(ctx);

  assert.deepEqual(extended.sort(), [
    "mio.gemini_cache",
    "mio.group_persona_binding",
    "mio.persona",
  ]);
  assert.deepEqual(optionsByName.get("mio.gemini_cache")?.unique, [["layer", "cacheKey", "modelName"]]);
});

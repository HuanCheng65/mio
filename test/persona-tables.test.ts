import test from "node:test";
import assert from "node:assert/strict";
import { Model } from "minato";
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
  assert.equal(optionsByName.get("mio.group_persona_binding")?.primary, "groupId");
});

test("extendPersonaTables uses groupId as the binding table primary key", () => {
  const models = new Map<string, Model<any>>();
  const ctx = {
    model: {
      extend(name: string, fields: any, options: any) {
        let model = models.get(name);
        if (!model) {
          model = new Model(name);
          models.set(name, model);
        }
        model.extend(fields, options);
      },
    },
  } as any;

  assert.doesNotThrow(() => extendPersonaTables(ctx));
  assert.equal(models.get("mio.group_persona_binding")?.primary, "groupId");
});

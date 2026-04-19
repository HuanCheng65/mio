import test from "node:test";
import assert from "node:assert/strict";
import { registerConsoleListeners } from "../src/console-listeners";

function createFakeConsoleCtx(registered: string[]) {
  return {
    inject(_deps: string[], callback: (ctx: any) => void) {
      callback({
        console: {
          addEntry() {},
          addListener(name: string) {
            registered.push(name);
          },
        },
        database: {
          async get() {
            return [];
          },
        },
      });
    },
  };
}

function createFakePersonaService() {
  return {};
}

test("console listeners expose persona CRUD and binding events", async () => {
  const registered: string[] = [];
  const ctx = createFakeConsoleCtx(registered);

  registerConsoleListeners(ctx as any, console, null as any, createFakePersonaService() as any);

  assert.ok(registered.includes("mio/persona-list"));
  assert.ok(registered.includes("mio/persona-save"));
  assert.ok(registered.includes("mio/persona-delete"));
  assert.ok(registered.includes("mio/persona-bind-group"));
});

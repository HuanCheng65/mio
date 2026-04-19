import test from "node:test";
import assert from "node:assert/strict";
import { registerConsoleListeners } from "../src/console-listeners";

function createFakeConsoleCtx(registered: string[], handlers: Map<string, (...args: any[]) => any>) {
  return {
    inject(_deps: string[], callback: (ctx: any) => void) {
      callback({
        console: {
          addEntry() {},
          addListener(name: string, handler: (...args: any[]) => any) {
            registered.push(name);
            handlers.set(name, handler);
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
  const handlers = new Map<string, (...args: any[]) => any>();
  const ctx = createFakeConsoleCtx(registered, handlers);

  registerConsoleListeners(ctx as any, console, null as any, createFakePersonaService() as any);

  assert.ok(registered.includes("mio/persona-list"));
  assert.ok(registered.includes("mio/persona-save"));
  assert.ok(registered.includes("mio/persona-delete"));
  assert.ok(registered.includes("mio/persona-bind-group"));
});

test("persona delete does not invalidate caches if deletion fails", async () => {
  const registered: string[] = [];
  const handlers = new Map<string, (...args: any[]) => any>();
  const ctx = createFakeConsoleCtx(registered, handlers);
  let invalidated = 0;
  const personaService = {
    async listBoundGroupIds() {
      return ["123"];
    },
    async deletePersona() {
      throw new Error("delete failed");
    },
  };
  const geminiCacheManager = {
    async invalidatePersonaCaches() {
      invalidated += 1;
    },
  };

  registerConsoleListeners(ctx as any, console, null as any, personaService as any, geminiCacheManager as any);

  await assert.rejects(() => handlers.get("mio/persona-delete")!("default"));
  assert.equal(invalidated, 0);
});

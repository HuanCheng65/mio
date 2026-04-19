import test from "node:test";
import assert from "node:assert/strict";
import { PersonaService, seedDefaultPersonaIfMissing } from "../src/persona/service";

interface DatabaseRowMap {
  "mio.persona": any[];
  "mio.group_persona_binding": any[];
  "mio.gemini_cache": any[];
}

function createFakeCtx() {
  const rows: DatabaseRowMap = {
    "mio.persona": [],
    "mio.group_persona_binding": [],
    "mio.gemini_cache": [],
  };

  const database = {
    async get(table: keyof DatabaseRowMap, query: Record<string, any>) {
      return rows[table].filter((row) =>
        Object.entries(query).every(([key, value]) => row[key] === value),
      );
    },
    async create(table: keyof DatabaseRowMap, data: Record<string, any>) {
      const row = { ...data };
      rows[table].push(row);
      return row;
    },
    async set(table: keyof DatabaseRowMap, query: Record<string, any>, data: Record<string, any>) {
      const matches = rows[table].filter((row) =>
        Object.entries(query).every(([key, value]) => row[key] === value),
      );
      for (const row of matches) {
        Object.assign(row, data);
      }
    },
    async remove(table: keyof DatabaseRowMap, query: Record<string, any>) {
      rows[table] = rows[table].filter((row) =>
        !Object.entries(query).every(([key, value]) => row[key] === value),
      );
    },
  };

  return {
    database,
    baseDir: process.cwd(),
  } as any;
}

test("PersonaService resolves bound personas and falls back to default", async () => {
  const service = new PersonaService(createFakeCtx(), {
    defaultPersonaSeedFile: "mio.md",
  });

  await seedDefaultPersonaIfMissing(service);
  const alt = await service.createPersona({ name: "Alt", content: "# alt" });
  await service.bindGroup("123", alt.id);

  const bound = await service.resolveForGroup("123");
  const fallback = await service.resolveForGroup("999");

  assert.equal(bound.name, "Alt");
  assert.equal(fallback.isDefault, true);
});

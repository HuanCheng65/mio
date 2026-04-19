import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Context } from "koishi";
import type { MioPersonaRow } from "./types";

export interface PersonaRecord extends MioPersonaRow {}

interface PersonaServiceOptions {
  defaultPersonaSeedFile: string;
}

interface CreatePersonaInput {
  name: string;
  content: string;
}

interface RenamePersonaInput {
  personaId: string;
  name: string;
}

interface SavePersonaInput {
  personaId: string;
  content: string;
}

const DEFAULT_PERSONA_ID = "default";

function hashContent(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

function resolveSeedPath(seedFile: string) {
  return resolve(__dirname, "../../data/persona", seedFile);
}

export class PersonaService {
  private defaultPersonaSeedPromise: Promise<PersonaRecord> | null = null;

  constructor(
    private readonly ctx: Context,
    private readonly options: PersonaServiceOptions,
  ) {}

  async createPersona(input: CreatePersonaInput): Promise<PersonaRecord> {
    const now = Date.now();
    const row: PersonaRecord = {
      id: randomUUID(),
      name: input.name,
      content: input.content,
      contentHash: hashContent(input.content),
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    };

    await this.ctx.database.create("mio.persona", row);
    return row;
  }

  async listPersonas(): Promise<PersonaRecord[]> {
    const rows = await this.ctx.database.get("mio.persona", {});
    return rows.sort((a, b) => {
      if (a.isDefault !== b.isDefault) {
        return a.isDefault ? -1 : 1;
      }
      return b.updatedAt - a.updatedAt;
    });
  }

  async getPersona(personaId: string): Promise<PersonaRecord> {
    const rows = await this.ctx.database.get("mio.persona", { id: personaId });
    if (rows.length === 0) {
      throw new Error(`Persona not found: ${personaId}`);
    }
    return rows[0];
  }

  async duplicatePersona(personaId: string): Promise<PersonaRecord> {
    const source = await this.getPersona(personaId);
    return this.createPersona({
      name: `${source.name} Copy`,
      content: source.content,
    });
  }

  async renamePersona(input: RenamePersonaInput): Promise<PersonaRecord> {
    await this.ctx.database.set("mio.persona", { id: input.personaId }, {
      name: input.name,
      updatedAt: Date.now(),
    });
    return this.getPersona(input.personaId);
  }

  async savePersona(input: SavePersonaInput): Promise<PersonaRecord> {
    const updatedAt = Date.now();
    await this.ctx.database.set("mio.persona", { id: input.personaId }, {
      content: input.content,
      contentHash: hashContent(input.content),
      updatedAt,
    });
    return this.getPersona(input.personaId);
  }

  async deletePersona(personaId: string): Promise<void> {
    const persona = await this.getPersona(personaId);
    if (persona.isDefault) {
      throw new Error("Default persona cannot be deleted");
    }

    await this.ctx.database.remove("mio.group_persona_binding", { personaId });
    await this.ctx.database.remove("mio.persona", { id: personaId });
  }

  async setDefaultPersona(personaId: string): Promise<PersonaRecord> {
    const nextDefault = await this.getPersona(personaId);
    const currentDefaultRows = await this.ctx.database.get("mio.persona", { isDefault: true });

    for (const row of currentDefaultRows) {
      if (row.id !== personaId) {
        await this.ctx.database.set("mio.persona", { id: row.id }, {
          isDefault: false,
          updatedAt: Date.now(),
        });
      }
    }

    await this.ctx.database.set("mio.persona", { id: personaId }, {
      isDefault: true,
      updatedAt: Date.now(),
    });
    return this.getPersona(personaId);
  }

  async bindGroup(groupId: string, personaId: string): Promise<void> {
    const now = Date.now();
    const existing = await this.ctx.database.get("mio.group_persona_binding", { groupId });
    if (existing.length > 0) {
      await this.ctx.database.set("mio.group_persona_binding", { groupId }, { personaId, updatedAt: now });
      return;
    }

    await this.ctx.database.create("mio.group_persona_binding", {
      groupId,
      personaId,
      updatedAt: now,
    });
  }

  async unbindGroup(groupId: string): Promise<void> {
    await this.ctx.database.remove("mio.group_persona_binding", { groupId });
  }

  async listBindings(): Promise<Array<{ groupId: string; personaId: string; updatedAt: number }>> {
    return this.ctx.database.get("mio.group_persona_binding", {});
  }

  async listBoundGroupIds(personaId: string): Promise<string[]> {
    const rows = await this.ctx.database.get("mio.group_persona_binding", { personaId });
    return rows.map((row) => row.groupId);
  }

  async getCacheStats() {
    const rows = await this.ctx.database.get("mio.gemini_cache", {});
    return {
      total: rows.length,
      byPersona: rows.reduce<Record<string, number>>((acc, row) => {
        acc[row.personaId] = (acc[row.personaId] || 0) + 1;
        return acc;
      }, {}),
    };
  }

  async getDefaultPersona(): Promise<PersonaRecord> {
    const rows = await this.ctx.database.get("mio.persona", { isDefault: true });
    if (rows.length > 0) {
      return rows[0];
    }
    return this.seedDefaultPersonaIfMissing();
  }

  async resolveForGroup(groupId: string): Promise<PersonaRecord> {
    const bindings = await this.ctx.database.get("mio.group_persona_binding", { groupId });
    if (bindings.length > 0) {
      const personas = await this.ctx.database.get("mio.persona", { id: bindings[0].personaId });
      if (personas.length > 0) {
        return personas[0];
      }
    }

    return this.getDefaultPersona();
  }

  async seedDefaultPersonaIfMissing(): Promise<PersonaRecord> {
    if (!this.defaultPersonaSeedPromise) {
      this.defaultPersonaSeedPromise = (async () => {
        const existing = await this.ctx.database.get("mio.persona", { isDefault: true });
        if (existing.length > 0) {
          return existing[0];
        }

        const now = Date.now();
        const content = readFileSync(resolveSeedPath(this.options.defaultPersonaSeedFile), "utf8");
        const row: PersonaRecord = {
          id: DEFAULT_PERSONA_ID,
          name: "Default",
          content,
          contentHash: hashContent(content),
          isDefault: true,
          createdAt: now,
          updatedAt: now,
        };

        await this.ctx.database.create("mio.persona", row);
        return row;
      })();
    }

    try {
      return await this.defaultPersonaSeedPromise;
    } finally {
      this.defaultPersonaSeedPromise = null;
    }
  }
}

export async function seedDefaultPersonaIfMissing(service: PersonaService): Promise<PersonaRecord> {
  return service.seedDefaultPersonaIfMissing();
}

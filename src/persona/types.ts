import { Context } from "koishi";

declare module "koishi" {
  interface Tables {
    "mio.gemini_cache": MioGeminiCacheRow;
    "mio.persona": MioPersonaRow;
    "mio.group_persona_binding": MioGroupPersonaBindingRow;
  }
}

export interface MioPersonaRow {
  id: string;
  name: string;
  content: string;
  contentHash: string;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MioGroupPersonaBindingRow {
  groupId: string;
  personaId: string;
  updatedAt: number;
}

export interface MioGeminiCacheRow {
  id: number;
  layer: string;
  cacheKey: string;
  personaId: string;
  personaHash: string;
  promptVersion: string;
  modelName: string;
  cacheName: string;
  expiresAt: number;
  updatedAt: number;
}

export function extendPersonaTables(ctx: Context) {
  ctx.model.extend("mio.persona", {
    id: "string(63)",
    name: "string(255)",
    content: "text",
    contentHash: "string(64)",
    isDefault: { type: "boolean", initial: false },
    createdAt: "unsigned(8)",
    updatedAt: "unsigned(8)",
  }, {
    primary: "id",
  });

  ctx.model.extend("mio.group_persona_binding", {
    groupId: "string(63)",
    personaId: "string(63)",
    updatedAt: "unsigned(8)",
  }, {
    unique: [["groupId"]],
  });

  ctx.model.extend("mio.gemini_cache", {
    id: "unsigned",
    layer: "string(63)",
    cacheKey: "string(255)",
    personaId: "string(63)",
    personaHash: "string(64)",
    promptVersion: "string(64)",
    modelName: "string(255)",
    cacheName: "string(255)",
    expiresAt: "unsigned(8)",
    updatedAt: "unsigned(8)",
  }, {
    autoInc: true,
    primary: "id",
    unique: [["layer", "cacheKey", "modelName"]],
  });
}

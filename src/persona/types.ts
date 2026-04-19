import { Context } from "koishi";

declare module "koishi" {
  interface Tables {
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

export function registerPersonaTables(ctx: Context) {
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
}

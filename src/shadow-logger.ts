import * as fs from "fs";
import * as path from "path";
import type { Action, SearchRequest } from "./types/response";

export interface ShadowLogInput {
  groupId: string;
  phase: "main" | "search";
  newMessages: { sender: string; content: string }[];
  thought: string;
  urge: number;
  silent: boolean;
  actions: Action[] | null;
  search: SearchRequest | null;
}

export class ShadowLogger {
  private dir: string;
  private initialized = false;

  constructor(dir: string) {
    this.dir = dir;
  }

  log(entry: ShadowLogInput): void {
    if (!this.initialized) {
      fs.mkdirSync(this.dir, { recursive: true });
      this.initialized = true;
    }

    const record = {
      timestamp: new Date().toISOString(),
      ...entry,
    };

    const filePath = path.join(this.dir, `${entry.groupId}.jsonl`);
    fs.appendFileSync(filePath, JSON.stringify(record) + "\n");
  }
}

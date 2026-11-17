import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "koishi";
import { DATA_DIR } from "../paths";

/**
 * agent 的提示词。插件 data/ 下的文件是种子：部署会用仓库里的版本覆盖它们，
 * 所以在 Console 里改的内容存数据库，有改动的用数据库的，没改动的跟着文件走。
 */
export const PROMPT_NAMES = ["persona", "environment", "reminder", "sleep"] as const;
export type PromptName = typeof PROMPT_NAMES[number];

export interface MioPromptRow {
  name: PromptName;
  content: string;
  updatedAt: number;
}

declare module "koishi" {
  interface Tables {
    "mio.prompt": MioPromptRow;
  }
}

export function extendPromptTable(ctx: Context): void {
  ctx.model.extend("mio.prompt", {
    name: "string(31)",
    content: "text",
    updatedAt: "unsigned(8)",
  }, {
    primary: "name",
  });
}

/** 运行时实际用到的三段：人设和环境说明拼成 system，提醒和睡前整理各自单独用 */
export interface AgentPrompts {
  /** 人设 + 环境说明。两者都是固定文本，不放时间等会变的内容，保证前缀可缓存 */
  systemPrompt: string;
  /** 唤醒时每一步请求末尾的说话提醒 */
  reminder: string;
  /** 睡前整理的说明，{time} 会换成当前时间 */
  sleep: string;
}

export interface PromptView {
  name: PromptName;
  /** 种子文件，相对插件 data/ */
  seedFile: string;
  content: string;
  seed: string;
  /** 数据库里有改动（和种子不同） */
  edited: boolean;
  updatedAt: number | null;
}

export class PromptStore {
  private prompts: AgentPrompts | null = null;

  constructor(private ctx: Context, private personaFile: string) {}

  seedFile(name: PromptName): string {
    return name === "persona" ? join("persona", this.personaFile) : join("agent", `${name}.md`);
  }

  private readSeed(name: PromptName): string {
    return readFileSync(join(DATA_DIR, this.seedFile(name)), "utf8").trim();
  }

  async list(): Promise<PromptView[]> {
    const rows = new Map((await this.ctx.database.get("mio.prompt", {})).map((r) => [r.name, r]));
    return PROMPT_NAMES.map((name) => {
      const seed = this.readSeed(name);
      const row = rows.get(name);
      return { name, seedFile: this.seedFile(name), content: row?.content ?? seed, seed, edited: row !== undefined, updatedAt: row?.updatedAt ?? null };
    });
  }

  /** 存改动；和种子一样时删掉改动，之后跟着文件走 */
  async save(name: PromptName, content: string): Promise<void> {
    if (!PROMPT_NAMES.includes(name)) throw new Error(`没有叫 ${name} 的提示词`);
    const trimmed = content.trim();
    if (!trimmed) throw new Error("提示词不能为空");
    if (trimmed === this.readSeed(name)) await this.ctx.database.remove("mio.prompt", { name });
    else await this.ctx.database.upsert("mio.prompt", [{ name, content: trimmed, updatedAt: Date.now() }]);
    await this.load();
  }

  async reset(name: PromptName): Promise<void> {
    await this.ctx.database.remove("mio.prompt", { name });
    await this.load();
  }

  /** 从数据库和种子文件重新读一遍；之后的请求用新内容 */
  async load(): Promise<AgentPrompts> {
    const views = new Map((await this.list()).map((v) => [v.name, v.content]));
    this.prompts = {
      systemPrompt: `${views.get("persona")}\n\n---\n\n${views.get("environment")}`,
      reminder: views.get("reminder")!,
      sleep: views.get("sleep")!,
    };
    return this.prompts;
  }

  current(): AgentPrompts {
    if (!this.prompts) throw new Error("提示词还没从数据库加载（ready 之前不应该唤醒）");
    return this.prompts;
  }
}

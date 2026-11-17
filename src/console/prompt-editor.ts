import { Context } from "koishi";
import type { PromptName, PromptStore, PromptView } from "../agent/prompts";

declare module "@koishijs/plugin-console" {
  interface Events {
    "mio/prompts"(): Promise<PromptView[]>;
    "mio/prompt-save"(name: PromptName, content: string): Promise<PromptView[]>;
    "mio/prompt-reset"(name: PromptName): Promise<PromptView[]>;
  }
}

type Logger = ReturnType<Context["logger"]>;

/** 提示词编辑接口和 mio.reload；保存后 agent 的下一步请求就用新内容 */
export function registerPromptEditor(ctx: Context, prompts: PromptStore, logger: Logger): void {
  ctx.on("ready", async () => {
    await prompts.load();
  });

  ctx.inject(["console"], (ctx) => {
    ctx.console.addListener("mio/prompts", () => prompts.list());
    ctx.console.addListener("mio/prompt-save", async (name, content) => {
      await prompts.save(name, content);
      logger.info(`[console] 提示词 ${name} 已保存`);
      return prompts.list();
    });
    ctx.console.addListener("mio/prompt-reset", async (name) => {
      await prompts.reset(name);
      logger.info(`[console] 提示词 ${name} 已恢复为文件里的版本`);
      return prompts.list();
    });
  });

  ctx.command("mio.reload", "重新读取提示词（Console 里的改动和插件 data/ 下的种子文件）", { authority: 4 }).action(async () => {
    await prompts.load();
    const edited = (await prompts.list()).filter((p) => p.edited).map((p) => p.name);
    logger.info("[admin] 提示词已重新读取");
    return `提示词已重新读取，下一次请求开始生效${edited.length > 0 ? `（用 Console 改过的：${edited.join("、")}）` : ""}`;
  });
}

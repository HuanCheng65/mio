import * as path from "path";
import { Context } from "koishi";
import { PLUGIN_ROOT } from "../paths";

export function registerConsoleShell(ctx: Context): void {
  ctx.inject(["console"], (ctx) => {
    ctx.console.addEntry({
      dev: path.resolve(PLUGIN_ROOT, "client/index.ts"),
      prod: path.resolve(PLUGIN_ROOT, "dist"),
    });
  });
}

import * as path from "path";
import { Context } from "koishi";

export function registerConsoleShell(ctx: Context): void {
  ctx.inject(["console"], (ctx) => {
    ctx.console.addEntry({
      dev: path.resolve(__dirname, "../../client/index.ts"),
      prod: path.resolve(__dirname, "../../dist"),
    });
  });
}

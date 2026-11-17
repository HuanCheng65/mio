import * as path from "path";
import { Context } from "koishi";
import { PLUGIN_ROOT } from "../paths";

export function registerConsoleShell(ctx: Context): void {
  ctx.inject(["console"], (ctx) => {
    ctx.console.addEntry({
      dev: path.resolve(PLUGIN_ROOT, "client/index.ts"),
      // console 生产模式只放行路径含 node_modules 的入口文件；PLUGIN_ROOT 是软链解析后的真实路径，会被 403
      prod: path.resolve(ctx.baseDir, "node_modules/koishi-plugin-mio/dist"),
    });
  });
}

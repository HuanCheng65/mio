import { resolve } from "path";

// 本文件直接位于 src/ 下：开发时 __dirname 是 src/，打包后所有模块合并进 lib/index.js，__dirname 是 lib/。
// 两种情况都比插件根目录低一层，所以插件内的路径统一从这里算，不要在子目录里用 __dirname 拼相对路径。
export const PLUGIN_ROOT = resolve(__dirname, "..");
export const DATA_DIR = resolve(PLUGIN_ROOT, "data");

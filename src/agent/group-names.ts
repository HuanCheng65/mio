import type { Context } from "koishi";
import { fetchQQGroupName } from "../platform/qq";
import { parseGroupId } from "../runtime/groups";

type Logger = ReturnType<Context["logger"]>;

const FRESH_MS = 6 * 3600_000;
const RETRY_MS = 10 * 60_000;

/**
 * 群名，渲染在每批消息的开头。不知道在哪个群时，她只能从聊天内容猜这是个什么群。
 * 官方 QQ 走"获取群基本信息"接口，其他平台走 Satori 的 getGuild。
 */
export class GroupNames {
  private cache = new Map<string, { name: string | undefined; at: number }>();

  constructor(private ctx: Context, private logger: Logger) {}

  async get(groupId: string, now = Date.now()): Promise<string | undefined> {
    const cached = this.cache.get(groupId);
    if (cached && now - cached.at < (cached.name === undefined ? RETRY_MS : FRESH_MS)) return cached.name;

    const { platform, channelId } = parseGroupId(groupId);
    const bot = this.ctx.bots.find((b) => b.platform === platform);
    if (!bot) return undefined;
    let name: string | undefined;
    try {
      name = platform === "qq" ? await fetchQQGroupName(bot, channelId) : (await bot.getGuild(channelId)).name;
    } catch (err) {
      // 群名只是给她的背景，查不到不该让整次唤醒失败；报出来，过一会儿再试
      this.logger.warn(`[${groupId}] 查不到群名:`, err);
    }
    this.cache.set(groupId, { name, at: now });
    return name;
  }
}

import { Context } from "koishi";

/**
 * 群开关存在 Koishi 自带的 channel 表上，用指令切换，不依赖任何平台的群号格式。
 * mio 内部统一用 `${platform}:${channelId}`（即 session.cid）作为 groupId。
 *
 * 除了 off，每种模式都会录制群聊：
 * - record：只录制，澪不醒（不需要模型配置）；她不知道这段时间发生过什么，醒来才看到
 * - on：澪正常看群、说话
 * - shadow：澪照常思考、记笔记、睡觉，但发出去的话被拦下；她以为自己说了（调试用）
 * - muted：只录制，澪不醒；她知道自己被静音了（进入和解除时 log 里各有一条通知）
 */
export const MIO_GROUP_MODES = ["off", "record", "on", "shadow", "muted"] as const;
export type MioGroupMode = typeof MIO_GROUP_MODES[number];

declare module "koishi" {
  interface Channel {
    mioMode: MioGroupMode;
  }
}

export function extendGroupFields(ctx: Context): void {
  ctx.model.extend("channel", {
    mioMode: { type: "string", initial: "off" },
  });
}

export function toGroupId(platform: string, channelId: string): string {
  return `${platform}:${channelId}`;
}

export function parseGroupId(groupId: string): { platform: string; channelId: string } {
  const index = groupId.indexOf(":");
  if (index <= 0) throw new Error(`invalid mio groupId (expected "platform:channelId"): ${groupId}`);
  return { platform: groupId.slice(0, index), channelId: groupId.slice(index + 1) };
}

export class GroupRegistry {
  private modes = new Map<string, MioGroupMode>();

  constructor(private ctx: Context) {
    ctx.on("ready", () => this.load());
  }

  private async load(): Promise<void> {
    const rows = await this.ctx.database.get("channel", { mioMode: { $ne: "off" } }, ["platform", "id", "mioMode"]);
    // 模式改过名或删过：数据库里留着旧值时一个群都不开，不能悄悄当成别的模式
    const unknown = rows.filter((row) => !MIO_GROUP_MODES.includes(row.mioMode));
    if (unknown.length > 0) {
      const list = unknown.map((row) => `${toGroupId(row.platform, row.id)}="${row.mioMode}"`).join(", ");
      throw new Error(`channel 表里有未知的 mioMode：${list}，请改成 ${MIO_GROUP_MODES.join(" / ")} 之一`);
    }
    this.modes.clear();
    for (const row of rows) this.modes.set(toGroupId(row.platform, row.id), row.mioMode);
  }

  /** 只更新内存；持久化由指令的 channelFields 完成 */
  set(groupId: string, mode: MioGroupMode): void {
    if (mode === "off") this.modes.delete(groupId);
    else this.modes.set(groupId, mode);
  }

  getMode(groupId: string): MioGroupMode {
    return this.modes.get(groupId) ?? "off";
  }

  /** 任何开启状态都会录制 */
  isRecorded(groupId: string): boolean {
    return this.getMode(groupId) !== "off";
  }

  /** 澪会醒来看群的群 */
  runsAgent(groupId: string): boolean {
    const mode = this.getMode(groupId);
    return mode === "on" || mode === "shadow";
  }

  isShadow(groupId: string): boolean {
    return this.getMode(groupId) === "shadow";
  }

  list(): string[] {
    return [...this.modes.keys()];
  }
}

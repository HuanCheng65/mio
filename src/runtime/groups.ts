import { Context } from "koishi";

/**
 * 群开关存在 Koishi 自带的 channel 表上，用指令切换，不依赖任何平台的群号格式。
 * mio 内部统一用 `${platform}:${channelId}`（即 session.cid）作为 groupId。
 */
export type MioGroupMode = "off" | "on" | "shadow";

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

  constructor(private ctx: Context) {}

  async load(): Promise<void> {
    const rows = await this.ctx.database.get("channel", { mioMode: { $ne: "off" } }, ["platform", "id", "mioMode"]);
    this.modes.clear();
    for (const row of rows) {
      this.modes.set(toGroupId(row.platform, row.id), row.mioMode);
    }
  }

  /** 只更新内存；持久化由指令的 channelFields 完成 */
  set(groupId: string, mode: MioGroupMode): void {
    if (mode === "off") this.modes.delete(groupId);
    else this.modes.set(groupId, mode);
  }

  getMode(groupId: string): MioGroupMode {
    return this.modes.get(groupId) ?? "off";
  }

  isActive(groupId: string): boolean {
    return this.getMode(groupId) !== "off";
  }

  isShadow(groupId: string): boolean {
    return this.getMode(groupId) === "shadow";
  }

  list(): string[] {
    return [...this.modes.keys()];
  }
}

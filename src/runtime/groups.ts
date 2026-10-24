import { Context } from "koishi";

/**
 * 群开关存在 Koishi 自带的 channel 表上，用指令切换，不依赖任何平台的群号格式。
 * mio 内部统一用 `${platform}:${channelId}`（即 session.cid）作为 groupId。
 *
 * - record：只录制群聊（不需要模型配置），为新运行时积累数据
 * - on / shadow：旧运行时回复 / 只推理不发送；同时也会录制
 * - agent / agent-shadow：新运行时回复 / 照常思考、记笔记、睡觉，但不往群里发；同时也会录制
 */
export type MioGroupMode = "off" | "record" | "on" | "shadow" | "agent" | "agent-shadow";

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

type ModeListener = (groupId: string, mode: MioGroupMode) => void | Promise<void>;

export class GroupRegistry {
  private modes = new Map<string, MioGroupMode>();
  private listeners: ModeListener[] = [];
  private loaded: Promise<void>;

  constructor(private ctx: Context) {
    let resolveLoaded!: () => void;
    this.loaded = new Promise((resolve) => (resolveLoaded = resolve));
    ctx.on("ready", async () => {
      await this.load();
      resolveLoaded();
    });
  }

  private async load(): Promise<void> {
    const rows = await this.ctx.database.get("channel", { mioMode: { $ne: "off" } }, ["platform", "id", "mioMode"]);
    this.modes.clear();
    for (const row of rows) {
      this.modes.set(toGroupId(row.platform, row.id), row.mioMode);
    }
  }

  /** 启动时从数据库加载完成后 resolve */
  whenLoaded(): Promise<void> {
    return this.loaded;
  }

  /** 只更新内存并通知监听者；持久化由指令的 channelFields 完成 */
  async set(groupId: string, mode: MioGroupMode): Promise<void> {
    if (mode === "off") this.modes.delete(groupId);
    else this.modes.set(groupId, mode);
    for (const listener of this.listeners) await listener(groupId, mode);
  }

  onChange(listener: ModeListener): void {
    this.listeners.push(listener);
  }

  getMode(groupId: string): MioGroupMode {
    return this.modes.get(groupId) ?? "off";
  }

  /** 任何开启状态都会录制 */
  isRecorded(groupId: string): boolean {
    return this.getMode(groupId) !== "off";
  }

  /** 由旧运行时处理（回复或影子推理）的群 */
  runsLegacyRuntime(groupId: string): boolean {
    const mode = this.getMode(groupId);
    return mode === "on" || mode === "shadow";
  }

  isShadow(groupId: string): boolean {
    return this.getMode(groupId) === "shadow";
  }

  /** 由新运行时处理的群 */
  runsAgent(groupId: string): boolean {
    const mode = this.getMode(groupId);
    return mode === "agent" || mode === "agent-shadow";
  }

  isAgentShadow(groupId: string): boolean {
    return this.getMode(groupId) === "agent-shadow";
  }

  list(): string[] {
    return [...this.modes.keys()];
  }

  legacyGroups(): string[] {
    return this.list().filter((g) => this.runsLegacyRuntime(g));
  }
}

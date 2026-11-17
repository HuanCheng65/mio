import { existsSync } from "node:fs";
import { link, mkdir, readFile, rename, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { Context } from "koishi";
import Anthropic, { toFile as toAnthropicFile } from "@anthropic-ai/sdk";
import OpenAI, { toFile } from "openai";
import sharp from "sharp";
import type { ImageTransportKind, ProviderConfig } from "../llm/provider";

/**
 * 请求里的一张图：内联 data URL，或 Files API 的引用（DeepSeek 的写法，file_id 和 type 平级；
 * 发给 Anthropic 时由 anthropic.ts 换成 image 块的 file 来源）
 */
export type ImagePart = { type: "image_url"; image_url: { url: string } } | { type: "file"; file_id: string };

/**
 * agent 怎么把 log 里的图交给模型，由供应商决定。同一张图每次都要给出同样的 part，前缀才能缓存。
 */
export interface ImageTransport {
  part(file: string): Promise<ImagePart>;
  /** 这些图按这种方式发出去，是否超出一次请求能带的量（超出就该睡前整理了） */
  overBudget(files: string[]): Promise<boolean>;
  /** 开新段之后调用：释放 before 之前准备好、且不在 keep 里的图，返回释放了几张 */
  release(keep: Set<string>, before: number): Promise<number>;
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

function mimeOf(file: string): string {
  const mime = MIME[extname(file)];
  if (!mime) throw new Error(`unsupported media type for ${file}`);
  return mime;
}

/**
 * 发送前把图缩到 maxPixels 以内。供应商服务端本来就会缩到它自己的目标尺寸，按同一目标先缩，
 * 模型看到的不变，请求和上传却小得多；原图留在 mediaDir 不动。
 * 结果按 maxPixels 分目录缓存，本来就够小的图硬链接过去，之后只需查文件在不在。
 * GIF 缩了会丢动画，WebP 也可能是动图，这两种原样发，交给服务端缩。
 */
export class ImageFitter {
  private dir: string;
  private pending = new Map<string, Promise<string>>();

  constructor(private mediaDir: string, private maxPixels: number) {
    this.dir = join(mediaDir, `fit-${maxPixels}`);
  }

  async path(file: string): Promise<string> {
    const mime = mimeOf(file);
    if (mime === "image/gif" || mime === "image/webp") return join(this.mediaDir, file);
    const target = join(this.dir, file);
    if (existsSync(target)) return target;
    // 两个群同时用到同一张图时只缩一次
    let task = this.pending.get(file);
    if (!task) {
      task = this.fit(file, mime, target).finally(() => this.pending.delete(file));
      this.pending.set(file, task);
    }
    return task;
  }

  private async fit(file: string, mime: string, target: string): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const source = join(this.mediaDir, file);
    const { width, height } = await sharp(source).metadata();
    const pixels = width * height;
    if (pixels <= this.maxPixels) {
      await link(source, target);
      return target;
    }
    const scale = Math.sqrt(this.maxPixels / pixels);
    const resized = sharp(source).autoOrient().resize(Math.round(width * scale), Math.round(height * scale));
    // 先写临时文件再改名：进程在写到一半时被杀，也不会留下一张残缺的图被一直用下去
    await (mime === "image/png" ? resized.png() : resized.jpeg({ quality: 90 })).toFile(`${target}.tmp`);
    await rename(`${target}.tmp`, target);
    return target;
  }
}

export interface FileUploader {
  upload(data: Buffer, name: string): Promise<string>;
  remove(fileId: string): Promise<void>;
}

export function openAIUploader(client: OpenAI): FileUploader {
  return {
    upload: async (data, name) => (await client.files.create({ file: await toFile(data, name), purpose: "user_data" })).id,
    remove: async (fileId) => {
      await client.files.delete(fileId);
    },
  };
}

export function anthropicUploader(client: Anthropic): FileUploader {
  return {
    // 显式带上 MIME：Anthropic 按文件类型决定它能不能当 image 块引用
    upload: async (data, name) => (await client.files.upload({ file: await toAnthropicFile(data, name, { type: mimeOf(name) }) })).id,
    remove: async (fileId) => {
      await client.files.delete(fileId);
    },
  };
}

export interface UploadedImageRow {
  providerId: string;
  file: string;
  fileId: string;
  createdAt: number;
}

declare module "koishi" {
  interface Tables {
    "mio.uploaded_image": UploadedImageRow;
    "mio.image_pin": ImagePinRow;
  }
}

export function extendImageTables(ctx: Context): void {
  ctx.model.extend("mio.image_pin", {
    providerId: "string(63)",
    file: "string(127)",
    transport: "string(31)",
    maxPixels: "unsigned(8)",
    createdAt: "unsigned(8)",
  }, {
    primary: ["providerId", "file"],
  });
  ctx.model.extend("mio.uploaded_image", {
    providerId: "string(63)",
    file: "string(127)",
    fileId: "string(127)",
    createdAt: "unsigned(8)",
  }, {
    primary: ["providerId", "file"],
  });
}

/**
 * 一个供应商经 Files API 上传过的图：每张图上传一次，请求里只带 file_id，请求体不再随图片数量增长。
 * 不设有效期（DeepSeek 和 Anthropic 默认都永久保存），不再被任何群当前段引用的图在开新段后删掉，
 * 免得撞上账号的文件数或存储上限。
 */
export class UploadedImages {
  private known = new Map<string, string>();
  private pending = new Map<string, Promise<string>>();

  constructor(private ctx: Context, private providerId: string, private uploader: FileUploader) {}

  /** path：还没传过时，要上传的那份（缩好的）图在哪 */
  fileId(file: string, path: () => Promise<string>): Promise<string> {
    const known = this.known.get(file);
    if (known) return Promise.resolve(known);
    // 两个群同时用到同一张图时只传一次
    let task = this.pending.get(file);
    if (!task) {
      task = this.lookupOrUpload(file, path).finally(() => this.pending.delete(file));
      this.pending.set(file, task);
    }
    return task;
  }

  async release(keep: Set<string>, before: number): Promise<number> {
    const rows = await this.ctx.database.get("mio.uploaded_image", { providerId: this.providerId, createdAt: { $lt: before } });
    let released = 0;
    for (const row of rows) {
      if (keep.has(row.file)) continue;
      await this.uploader.remove(row.fileId);
      await this.ctx.database.remove("mio.uploaded_image", { providerId: this.providerId, file: row.file });
      this.known.delete(row.file);
      released++;
    }
    return released;
  }

  private async lookupOrUpload(file: string, path: () => Promise<string>): Promise<string> {
    const [row] = await this.ctx.database.get("mio.uploaded_image", { providerId: this.providerId, file });
    let fileId = row?.fileId;
    if (!fileId) {
      const fitted = await path();
      fileId = await this.uploader.upload(await readFile(fitted), basename(fitted));
      // 传完立刻记下：唤醒中途失败，下次从没传的那张接着传
      await this.ctx.database.create("mio.uploaded_image", { providerId: this.providerId, file, fileId, createdAt: Date.now() });
    }
    this.known.set(file, fileId);
    return fileId;
  }
}

/** 一张图第一次发给某个供应商时用的发图设置；之后这张图发给它都按这个来 */
export interface ImagePinRow {
  providerId: string;
  file: string;
  transport: ImageTransportKind;
  maxPixels: number;
  createdAt: number;
}

type Pin = Pick<ImagePinRow, "transport" | "maxPixels">;

/** 供应商对应的客户端：OpenAI 兼容的供应商只有 openai，anthropic 的只有 anthropic */
export interface ProviderClients {
  openai?: OpenAI;
  anthropic?: Anthropic;
}

/**
 * 一个供应商的发图。每张图第一次发给它时，把当时的发图设置（方式、缩图大小）记进 mio.image_pin，
 * 之后这张图一直按记下的发，所以改发图配置只影响还没发过的图：已经发过的图块一个字节都不变，
 * 缓存和思考块签名都不受影响。图被释放（不再有群的当前段引用）时，记录一起删掉。
 */
export class PinnedImageTransport implements ImageTransport {
  private pins = new Map<string, Pin>();
  private pending = new Map<string, Promise<Pin>>();
  private fitters = new Map<number, ImageFitter>();
  private uploads: UploadedImages | undefined;

  constructor(
    private ctx: Context,
    private provider: ProviderConfig,
    private clients: ProviderClients,
    private mediaDir: string,
    /** 新图用的设置（当前配置） */
    private current: Pin,
    /** 当前配置是内联时的预算（字节） */
    private inlineBudgetBytes: number | undefined,
  ) {}

  async part(file: string): Promise<ImagePart> {
    const pin = await this.pin(file);
    const fitter = this.fitter(pin.maxPixels);
    if (pin.transport === "inline") {
      const data = await readFile(await fitter.path(file));
      return { type: "image_url", image_url: { url: `data:${mimeOf(file)};base64,${data.toString("base64")}` } };
    }
    return { type: "file", file_id: await this.uploaded().fileId(file, () => fitter.path(file)) };
  }

  /**
   * 只有当前配置是内联时才可能超：用 Files API 时新图不再占请求体，之前内联发过的图不会再变多。
   * 按每张图记下的方式算，还没发过的图按当前配置算；只读，不记新的设置。
   */
  async overBudget(files: string[]): Promise<boolean> {
    if (this.current.transport !== "inline") return false;
    let total = 0;
    for (const file of files) {
      const pin = this.pins.get(file) ?? (await this.storedPin(file)) ?? this.current;
      if (pin.transport !== "inline") continue;
      total += Math.ceil((await stat(await this.fitter(pin.maxPixels).path(file))).size / 3) * 4;
    }
    return total > this.inlineBudgetBytes!;
  }

  async release(keep: Set<string>, before: number): Promise<number> {
    // 当前配置不是 Files API 也可能有以前上传的图要删
    const uploaded = await this.ctx.database.get("mio.uploaded_image", { providerId: this.provider.id }, { limit: 1 });
    const released = uploaded.length > 0 ? await this.uploaded().release(keep, before) : 0;
    const rows = await this.ctx.database.get("mio.image_pin", { providerId: this.provider.id, createdAt: { $lt: before } }, ["file"]);
    for (const { file } of rows) {
      if (keep.has(file)) continue;
      await this.ctx.database.remove("mio.image_pin", { providerId: this.provider.id, file });
      this.pins.delete(file);
    }
    return released;
  }

  private pin(file: string): Promise<Pin> {
    const known = this.pins.get(file);
    if (known) return Promise.resolve(known);
    let task = this.pending.get(file);
    if (!task) {
      task = this.lookupOrPin(file).finally(() => this.pending.delete(file));
      this.pending.set(file, task);
    }
    return task;
  }

  private async lookupOrPin(file: string): Promise<Pin> {
    let pin = await this.storedPin(file);
    if (!pin) {
      pin = { ...this.current };
      await this.ctx.database.create("mio.image_pin", { providerId: this.provider.id, file, ...pin, createdAt: Date.now() });
    }
    this.pins.set(file, pin);
    return pin;
  }

  private async storedPin(file: string): Promise<Pin | undefined> {
    const [row] = await this.ctx.database.get("mio.image_pin", { providerId: this.provider.id, file });
    return row ? { transport: row.transport, maxPixels: row.maxPixels } : undefined;
  }

  private fitter(maxPixels: number): ImageFitter {
    let fitter = this.fitters.get(maxPixels);
    if (!fitter) {
      fitter = new ImageFitter(this.mediaDir, maxPixels);
      this.fitters.set(maxPixels, fitter);
    }
    return fitter;
  }

  /** 记下的方式是 Files API 时用；一个供应商只有一种 Files API（按供应商类型），和当前配置无关 */
  private uploaded(): UploadedImages {
    if (!this.uploads) {
      const uploader = filesUploader(this.provider.type === "anthropic" ? "anthropic-files" : "deepseek-files", this.clients);
      if (typeof uploader === "string") throw new Error(`供应商 ${this.provider.id}: ${uploader}`);
      this.uploads = new UploadedImages(this.ctx, this.provider.id, uploader);
    }
    return this.uploads;
  }
}

function filesUploader(transport: "deepseek-files" | "anthropic-files", clients: ProviderClients): FileUploader | string {
  if (transport === "deepseek-files") return clients.openai ? openAIUploader(clients.openai) : "不是 OpenAI 兼容的，不能用 deepseek-files 发图";
  return clients.anthropic ? anthropicUploader(clients.anthropic) : "不是 anthropic，不能用 anthropic-files 发图";
}

/** 按供应商的发图配置建它的发图方式；配置不全或和供应商类型不配时返回原因 */
export function createImageTransport(ctx: Context, provider: ProviderConfig, clients: ProviderClients, mediaDir: string): ImageTransport | string {
  const images = provider.images;
  if (!images?.transport || !images.maxPixels) {
    return `agent 模型的供应商 ${provider.id} 没有配置发图方式（images.transport / images.maxPixels），新运行时未启动`;
  }
  if (images.transport === "inline") {
    if (!images.inlineBudgetMiB) return `供应商 ${provider.id} 用内联发图，需要配置 images.inlineBudgetMiB，新运行时未启动`;
  } else {
    const uploader = filesUploader(images.transport, clients);
    if (typeof uploader === "string") return `供应商 ${provider.id} ${uploader}，新运行时未启动`;
  }
  const budget = images.transport === "inline" ? images.inlineBudgetMiB! * 2 ** 20 : undefined;
  return new PinnedImageTransport(ctx, provider, clients, mediaDir, { transport: images.transport, maxPixels: images.maxPixels }, budget);
}

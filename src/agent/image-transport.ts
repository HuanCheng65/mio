import { existsSync } from "node:fs";
import { link, mkdir, readFile, rename, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { Context } from "koishi";
import Anthropic, { toFile as toAnthropicFile } from "@anthropic-ai/sdk";
import OpenAI, { toFile } from "openai";
import sharp from "sharp";
import type { ProviderConfig } from "../llm/provider";

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

/** 每一步都把图以 base64 随请求发出去。请求体随图片数量增长，所以要有预算。 */
export class InlineImageTransport implements ImageTransport {
  constructor(private fitter: ImageFitter, private budgetBytes: number) {}

  async part(file: string): Promise<ImagePart> {
    const data = await readFile(await this.fitter.path(file));
    return { type: "image_url", image_url: { url: `data:${mimeOf(file)};base64,${data.toString("base64")}` } };
  }

  async overBudget(files: string[]): Promise<boolean> {
    let total = 0;
    for (const file of files) total += Math.ceil((await stat(await this.fitter.path(file))).size / 3) * 4;
    return total > this.budgetBytes;
  }

  async release(): Promise<number> {
    return 0;
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
  }
}

export function extendUploadedImageTable(ctx: Context): void {
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
 * 每张图经供应商的 Files API 上传一次，请求里只带 file_id，请求体不再随图片数量增长。
 * 不设有效期（DeepSeek 和 Anthropic 默认都永久保存），不再被任何群当前段引用的图在开新段后删掉，
 * 免得撞上账号的文件数或存储上限。
 */
export class FilesApiTransport implements ImageTransport {
  private known = new Map<string, string>();
  private pending = new Map<string, Promise<string>>();

  constructor(private ctx: Context, private providerId: string, private uploader: FileUploader, private fitter: ImageFitter) {}

  async part(file: string): Promise<ImagePart> {
    return { type: "file", file_id: await this.fileId(file) };
  }

  async overBudget(): Promise<boolean> {
    return false;
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

  private fileId(file: string): Promise<string> {
    const known = this.known.get(file);
    if (known) return Promise.resolve(known);
    // 两个群同时用到同一张图时只传一次
    let task = this.pending.get(file);
    if (!task) {
      task = this.lookupOrUpload(file).finally(() => this.pending.delete(file));
      this.pending.set(file, task);
    }
    return task;
  }

  private async lookupOrUpload(file: string): Promise<string> {
    const [row] = await this.ctx.database.get("mio.uploaded_image", { providerId: this.providerId, file });
    let fileId = row?.fileId;
    if (!fileId) {
      const path = await this.fitter.path(file);
      fileId = await this.uploader.upload(await readFile(path), basename(path));
      // 传完立刻记下：唤醒中途失败，下次从没传的那张接着传
      await this.ctx.database.create("mio.uploaded_image", { providerId: this.providerId, file, fileId, createdAt: Date.now() });
    }
    this.known.set(file, fileId);
    return fileId;
  }
}

/** 供应商对应的客户端：OpenAI 兼容的供应商只有 openai，anthropic 的只有 anthropic */
export interface ProviderClients {
  openai?: OpenAI;
  anthropic?: Anthropic;
}

/** 按供应商配置选发图方式；配置不全或和供应商类型不配时返回原因 */
export function createImageTransport(ctx: Context, provider: ProviderConfig, clients: ProviderClients, mediaDir: string): ImageTransport | string {
  const images = provider.images;
  if (!images?.transport || !images.maxPixels) {
    return `agent 模型的供应商 ${provider.id} 没有配置发图方式（images.transport / images.maxPixels），新运行时未启动`;
  }
  const fitter = new ImageFitter(mediaDir, images.maxPixels);
  switch (images.transport) {
    case "deepseek-files":
      if (!clients.openai) return `供应商 ${provider.id} 不是 OpenAI 兼容的，不能用 deepseek-files 发图，新运行时未启动`;
      return new FilesApiTransport(ctx, provider.id, openAIUploader(clients.openai), fitter);
    case "anthropic-files":
      if (!clients.anthropic) return `供应商 ${provider.id} 不是 anthropic，不能用 anthropic-files 发图，新运行时未启动`;
      return new FilesApiTransport(ctx, provider.id, anthropicUploader(clients.anthropic), fitter);
    case "inline":
      if (!images.inlineBudgetMiB) return `供应商 ${provider.id} 用内联发图，需要配置 images.inlineBudgetMiB，新运行时未启动`;
      return new InlineImageTransport(fitter, images.inlineBudgetMiB * 2 ** 20);
  }
}

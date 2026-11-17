import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const DOWNLOAD_TIMEOUT_MS = 15_000;
const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"]);

type Kind = "png" | "jpg" | "gif" | "webp" | "heif";

function kindOf(buf: Buffer): Kind | null {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "gif";
  if (buf.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  // iPhone 照片（HEIC）：ISO 媒体容器，ftyp 里的品牌是 HEIF 系列
  if (buf.subarray(4, 8).toString("ascii") === "ftyp" && HEIF_BRANDS.has(buf.subarray(8, 12).toString("ascii"))) return "heif";
  return null;
}

/**
 * HEIC 多是 HEVC 编码，预编译的 sharp 不带 HEVC 解码器，用 libheif 的 heif-convert 转成 JPEG
 * （服务器上 apt install libheif-examples；libheif-plugin-libde265 提供解码）。
 */
async function heifToJpeg(buf: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "mio-heif-"));
  try {
    const input = join(dir, "in.heic");
    const output = join(dir, "out.jpg");
    await writeFile(input, buf);
    await promisify(execFile)("heif-convert", ["-q", "90", input, output]);
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * 录制时把图片存到本地：平台的图片链接会过期，回放和日后回看都要用原图。
 * 文件按原始内容的哈希命名，同一张图只存一份。
 *
 * 只存发给模型时一定处理得了的图：存下的图会留在 log 里，之后每次请求都要带上，
 * 处理不了的图会让这个群此后每次唤醒都失败。识别不了或解不开的图在这里就报错，
 * 由录制方按"没能保存"记下（log 里只写一句文字）。HEIC 转成 JPEG 再存。
 */
export class MediaStore {
  constructor(
    private dir: string,
    private convertHeif: (buf: Buffer) => Promise<Buffer> = heifToJpeg,
  ) {}

  /** 返回相对 dir 的文件名 */
  async save(url: string): Promise<string> {
    const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return this.store(Buffer.from(await res.arrayBuffer()));
  }

  async store(original: Buffer): Promise<string> {
    const kind = kindOf(original);
    if (!kind) throw new Error(`不支持的图片格式（文件头 ${original.subarray(0, 12).toString("hex")}）`);
    const [buf, ext] = kind === "heif" ? [await this.convertHeif(original), "jpg"] : [original, kind];
    // 只读文件头：确认 sharp 认得、尺寸读得出来，缩图时才不会出错
    const { width, height } = await sharp(buf).metadata();
    if (!width || !height) throw new Error(`读不出图片尺寸（${ext}）`);

    const name = `${createHash("sha256").update(original).digest("hex").slice(0, 32)}.${ext}`;
    const path = join(this.dir, name);
    if (!existsSync(path)) {
      await mkdir(this.dir, { recursive: true });
      await writeFile(path, buf);
    }
    return name;
  }
}

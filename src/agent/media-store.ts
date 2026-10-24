import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DOWNLOAD_TIMEOUT_MS = 15_000;

function extensionOf(buf: Buffer): string {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "gif";
  if (buf.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return "bin";
}

/**
 * 录制时把图片存到本地：平台的图片链接会过期，回放和日后回看都要用原图。
 * 文件按内容哈希命名，同一张图只存一份。
 */
export class MediaStore {
  constructor(private dir: string) {}

  /** 返回相对 dir 的文件名 */
  async save(url: string): Promise<string> {
    const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const name = `${createHash("sha256").update(buf).digest("hex").slice(0, 32)}.${extensionOf(buf)}`;
    const path = join(this.dir, name);
    if (!existsSync(path)) {
      await mkdir(this.dir, { recursive: true });
      await writeFile(path, buf);
    }
    return name;
  }
}

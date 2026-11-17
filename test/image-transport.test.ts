import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "koishi";
import sqlite from "@koishijs/plugin-database-sqlite";
import { Jimp } from "jimp";
import sharp from "sharp";
import { createImageTransport, extendImageTables, ImageFitter, UploadedImages, type FileUploader, type ImageTransport } from "../src/agent/image-transport";
import type { ProviderConfig } from "../src/llm/provider";

async function media(images: Record<string, { width: number; height: number; mime?: "image/png" | "image/jpeg" }>) {
  const dir = mkdtempSync(join(tmpdir(), "mio-media-"));
  for (const [file, { width, height, mime }] of Object.entries(images)) {
    const image = new Jimp({ width, height, color: 0x3366ccff });
    writeFileSync(join(dir, file), mime === "image/jpeg" ? await image.getBuffer("image/jpeg") : await image.getBuffer("image/png"));
  }
  return dir;
}

async function database() {
  const app = new Context();
  app.plugin(sqlite, { path: ":memory:" });
  extendImageTables(app);
  await app.start();
  return app;
}

function fakeUploader() {
  const uploads: string[] = [];
  const removed: string[] = [];
  const uploader: FileUploader = {
    async upload(data, name) {
      uploads.push(name);
      return `file-${uploads.length}`;
    },
    async remove(fileId) {
      removed.push(fileId);
    },
  };
  return { uploader, uploads, removed };
}

test("images within the pixel target are linked as they are, larger ones shrink to it", async () => {
  const dir = await media({ "small.png": { width: 20, height: 10 }, "big.jpg": { width: 400, height: 100, mime: "image/jpeg" } });
  const fitter = new ImageFitter(dir, 50 * 50);

  const small = await fitter.path("small.png");
  assert.equal(statSync(small).ino, statSync(join(dir, "small.png")).ino);

  const big = await Jimp.read(await fitter.path("big.jpg"));
  assert.ok(big.width * big.height <= 50 * 50);
  assert.equal(Math.round(big.width / big.height), 4, "keeps the aspect ratio");
  assert.equal(big.mime, "image/jpeg");
});

test("with a long-edge cap, long screenshots and long GIFs are shrunk to it; without one they are not", async () => {
  const dir = await media({ "long.png": { width: 20, height: 400 }, "short.png": { width: 20, height: 40 } });
  await sharp(join(dir, "long.png")).gif().toFile(join(dir, "long.gif"));

  const capped = new ImageFitter(dir, 100_000, 100);
  const long = await Jimp.read(await capped.path("long.png"));
  assert.deepEqual([long.width, long.height], [5, 100]);
  assert.equal(statSync(await capped.path("short.png")).ino, statSync(join(dir, "short.png")).ino);
  const gif = await sharp(await capped.path("long.gif")).metadata();
  assert.deepEqual([gif.format, gif.width, gif.height], ["gif", 5, 100]);

  const uncapped = new ImageFitter(dir, 100_000);
  assert.equal(statSync(await uncapped.path("long.png")).ino, statSync(join(dir, "long.png")).ino);
  assert.equal(await uncapped.path("long.gif"), join(dir, "long.gif"));
});

test("photos with an EXIF rotation are shrunk by their upright size", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mio-media-"));
  // 存成 400×100，EXIF 说要转 90°：转正后是 100×400
  await sharp({ create: { width: 400, height: 100, channels: 3, background: "#3366cc" } }).jpeg().withMetadata({ orientation: 6 }).toFile(join(dir, "photo.jpg"));
  const fitted = await sharp(await new ImageFitter(dir, 50 * 200).path("photo.jpg")).metadata();
  assert.deepEqual([fitted.width, fitted.height], [50, 200]);
});

test("GIF and WebP go out untouched, unknown types are refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mio-media-"));
  const fitter = new ImageFitter(dir, 10);
  assert.equal(await fitter.path("a.gif"), join(dir, "a.gif"));
  assert.equal(await fitter.path("a.webp"), join(dir, "a.webp"));
  await assert.rejects(fitter.path("a.bin"), /unsupported media type/);
});

const provider = (images: ProviderConfig["images"]): ProviderConfig => ({ id: "p", name: "P", type: "openai", apiKey: "k", images });
const clients = (uploader: FileUploader) => ({ openai: {} as any, uploader });

/** createImageTransport 建出来的发图方式，上传换成假的 */
function transport(app: Context, dir: string, images: ProviderConfig["images"], uploader: FileUploader): ImageTransport {
  const t = createImageTransport(app, provider(images), clients(uploader), dir);
  if (typeof t === "string") throw new Error(t);
  (t as any).uploads = new UploadedImages(app, "p", uploader);
  return t;
}

test("inline parts are stable data URLs and the budget counts their base64 size", async () => {
  const dir = await media({ "a.png": { width: 8, height: 8 } });
  const app = await database();
  const size = statSync(join(dir, "a.png")).size;
  const encoded = Math.ceil(size / 3) * 4;
  const t = transport(app, dir, { transport: "inline", maxPixels: 64 * 64, inlineBudgetMiB: (encoded * 2) / 2 ** 20 }, fakeUploader().uploader);

  const part = await t.part("a.png");
  assert.deepEqual(await t.part("a.png"), part);
  assert.match((part as { image_url: { url: string } }).image_url.url, /^data:image\/png;base64,/);
  assert.equal(await t.overBudget(["a.png", "a.png"]), false);
  assert.equal(await t.overBudget(["a.png", "a.png", "a.png"]), true);
  await app.stop();
});

test("each image is uploaded once and then referenced by file_id, also after a restart", async () => {
  const dir = await media({ "a.png": { width: 8, height: 8 } });
  const app = await database();
  const { uploader, uploads } = fakeUploader();
  const images = { transport: "deepseek-files" as const, maxPixels: 64 * 64 };

  const t = transport(app, dir, images, uploader);
  const [first, second] = await Promise.all([t.part("a.png"), t.part("a.png")]);
  assert.deepEqual(first, { type: "file", file_id: "file-1" });
  assert.deepEqual(second, first);

  assert.deepEqual(await transport(app, dir, images, uploader).part("a.png"), first);
  assert.deepEqual(uploads, ["a.png"]);
  assert.equal(await t.overBudget(["a.png"]), false);
  await app.stop();
});

test("an image keeps the settings it was first sent with; changed settings only apply to new images", async () => {
  const dir = await media({ "old.png": { width: 100, height: 100 }, "new.png": { width: 100, height: 100 } });
  const app = await database();
  const { uploader, uploads } = fakeUploader();

  const before = await transport(app, dir, { transport: "inline", maxPixels: 50 * 50, inlineBudgetMiB: 1 }, uploader).part("old.png");

  // 改成更大的缩图：旧图不变，新图按新尺寸
  const bigger = transport(app, dir, { transport: "inline", maxPixels: 80 * 80, inlineBudgetMiB: 1 }, uploader);
  assert.deepEqual(await bigger.part("old.png"), before);
  const fresh = await bigger.part("new.png");
  assert.equal((await Jimp.read(join(dir, "fit-6400", "new.png"))).width, 80);
  assert.ok(!existsSync(join(dir, "fit-6400", "old.png")), "the old image is never refitted to the new size");

  // 改成 Files API：之前内联发过的两张照旧内联，只有没发过的图上传；也不再按内联预算算
  const files = transport(app, dir, { transport: "deepseek-files", maxPixels: 80 * 80 }, uploader);
  assert.deepEqual(await files.part("old.png"), before);
  assert.deepEqual(await files.part("new.png"), fresh);
  writeFileSync(join(dir, "later.png"), readFileSync(join(dir, "new.png")));
  assert.deepEqual(await files.part("later.png"), { type: "file", file_id: "file-1" });
  assert.deepEqual(uploads, ["later.png"]);
  assert.equal(await files.overBudget(["old.png", "new.png", "later.png"]), false);

  // 改回内联：用 Files API 发过的那张照旧引用 file_id，预算只算内联发的
  const inline = transport(app, dir, { transport: "inline", maxPixels: 80 * 80, inlineBudgetMiB: 1 }, uploader);
  assert.deepEqual(await inline.part("later.png"), { type: "file", file_id: "file-1" });
  await app.stop();
});

test("release deletes uploads and pinned settings that nothing keeps and that predate the cut-off", async () => {
  const dir = await media({ "keep.png": { width: 8, height: 8 }, "old.png": { width: 8, height: 8 }, "fresh.png": { width: 8, height: 8 } });
  const app = await database();
  const { uploader, removed } = fakeUploader();
  const t = transport(app, dir, { transport: "deepseek-files", maxPixels: 64 * 64 }, uploader);
  await t.part("keep.png");
  await t.part("old.png");
  await app.database.create("mio.uploaded_image", { providerId: "other", file: "old.png", fileId: "other-1", createdAt: 0 });
  const cutoff = Date.now() + 1;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await t.part("fresh.png");

  assert.equal(await t.release(new Set(["keep.png"]), cutoff), 1);
  assert.deepEqual(removed, ["file-2"]);
  const left = await app.database.get("mio.uploaded_image", {});
  assert.deepEqual(left.map((r) => `${r.providerId}:${r.file}`).sort(), ["other:old.png", "p:fresh.png", "p:keep.png"]);
  const pins = await app.database.get("mio.image_pin", {});
  assert.deepEqual(pins.map((r) => r.file).sort(), ["fresh.png", "keep.png"]);

  // 释放之后再用到，按当前配置重新记、重新上传
  assert.deepEqual(await t.part("old.png"), { type: "file", file_id: "file-4" });

  // 当前配置换成内联，以前上传的图照样能释放
  const inline = transport(app, dir, { transport: "inline", maxPixels: 64 * 64, inlineBudgetMiB: 1 }, uploader);
  assert.equal(await inline.release(new Set(), Date.now() + 1), 3);
  await app.stop();
});

test("settings that do not fit the provider are refused at startup", async () => {
  const app = await database();
  assert.match(createImageTransport(app, provider({ transport: "inline", maxPixels: 1 }), {}, "/tmp") as string, /inlineBudgetMiB/);
  assert.match(createImageTransport(app, provider({ transport: "anthropic-files", maxPixels: 1 }), { openai: {} as any }, "/tmp") as string, /不是 anthropic/);
  assert.match(createImageTransport(app, provider(undefined), {}, "/tmp") as string, /没有配置发图方式/);
  await app.stop();
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "koishi";
import sqlite from "@koishijs/plugin-database-sqlite";
import { Jimp } from "jimp";
import { DeepSeekFilesTransport, extendUploadedImageTable, ImageFitter, InlineImageTransport, type FileUploader } from "../src/agent/image-transport";

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
  extendUploadedImageTable(app);
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

test("GIF and WebP go out untouched, unknown types are refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mio-media-"));
  const fitter = new ImageFitter(dir, 10);
  assert.equal(await fitter.path("a.gif"), join(dir, "a.gif"));
  assert.equal(await fitter.path("a.webp"), join(dir, "a.webp"));
  await assert.rejects(fitter.path("a.bin"), /unsupported media type/);
});

test("inline parts are stable data URLs and the budget counts their base64 size", async () => {
  const dir = await media({ "a.png": { width: 8, height: 8 } });
  const size = statSync(join(dir, "a.png")).size;
  const encoded = Math.ceil(size / 3) * 4;
  const transport = new InlineImageTransport(new ImageFitter(dir, 64 * 64), encoded * 2);

  const part = await transport.part("a.png");
  assert.deepEqual(await transport.part("a.png"), part);
  assert.match((part as { image_url: { url: string } }).image_url.url, /^data:image\/png;base64,/);
  assert.equal(await transport.overBudget(["a.png", "a.png"]), false);
  assert.equal(await transport.overBudget(["a.png", "a.png", "a.png"]), true);
});

test("each image is uploaded once and then referenced by file_id, also after a restart", async () => {
  const dir = await media({ "a.png": { width: 8, height: 8 } });
  const app = await database();
  const { uploader, uploads } = fakeUploader();
  const fitter = new ImageFitter(dir, 64 * 64);

  const transport = new DeepSeekFilesTransport(app, "ds", uploader, fitter);
  const [first, second] = await Promise.all([transport.part("a.png"), transport.part("a.png")]);
  assert.deepEqual(first, { type: "file", file_id: "file-1" });
  assert.deepEqual(second, first);

  const restarted = new DeepSeekFilesTransport(app, "ds", uploader, fitter);
  assert.deepEqual(await restarted.part("a.png"), first);
  assert.deepEqual(uploads, ["a.png"]);
  assert.equal(await transport.overBudget(), false);
  await app.stop();
});

test("release deletes this provider's uploads that nothing keeps and that predate the cut-off", async () => {
  const dir = await media({ "keep.png": { width: 8, height: 8 }, "old.png": { width: 8, height: 8 }, "fresh.png": { width: 8, height: 8 } });
  const app = await database();
  const { uploader, removed } = fakeUploader();
  const transport = new DeepSeekFilesTransport(app, "ds", uploader, new ImageFitter(dir, 64 * 64));
  await transport.part("keep.png");
  await transport.part("old.png");
  await app.database.create("mio.uploaded_image", { providerId: "other", file: "old.png", fileId: "other-1", createdAt: 0 });
  const cutoff = Date.now() + 1;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await transport.part("fresh.png");

  assert.equal(await transport.release(new Set(["keep.png"]), cutoff), 1);
  assert.deepEqual(removed, ["file-2"]);
  const left = await app.database.get("mio.uploaded_image", {});
  assert.deepEqual(left.map((r) => `${r.providerId}:${r.file}`).sort(), ["ds:fresh.png", "ds:keep.png", "other:old.png"]);

  // 释放之后再用到，会重新上传
  assert.deepEqual(await transport.part("old.png"), { type: "file", file_id: "file-4" });
  await app.stop();
});

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { MediaStore } from "../src/agent/media-store";

const image = (format: "png" | "jpeg") => sharp({ create: { width: 4, height: 3, channels: 3, background: "#f80" } })[format]().toBuffer();
// HEIC 文件头：ftyp 盒子，品牌 heic
const heicHeader = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(16)]);

test("images sharp can read are stored under their content hash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mio-media-"));
  const store = new MediaStore(dir);
  const png = await image("png");
  const name = await store.store(png);
  assert.match(name, /^[0-9a-f]{32}\.png$/);
  assert.deepEqual(await readFile(join(dir, name)), png);
  assert.equal(await store.store(png), name, "the same image is stored once");
});

test("HEIC photos are converted to JPEG", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mio-media-"));
  const jpeg = await image("jpeg");
  const store = new MediaStore(dir, async (buf) => {
    assert.deepEqual(buf, heicHeader);
    return jpeg;
  });
  const name = await store.store(heicHeader);
  assert.match(name, /^[0-9a-f]{32}\.jpg$/);
  assert.deepEqual(await readFile(join(dir, name)), jpeg);
});

test("images that could not be sent to the model are refused, not stored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mio-media-"));
  const store = new MediaStore(dir);
  await assert.rejects(store.store(Buffer.from("not an image at all")), /不支持的图片格式（文件头 6e6f/);
  const broken = Buffer.concat([(await image("png")).subarray(0, 8), Buffer.alloc(40)]);
  await assert.rejects(store.store(broken));
  const failing = new MediaStore(dir, async () => { throw new Error("heif-convert: decoder plugin missing"); });
  await assert.rejects(failing.store(heicHeader), /decoder plugin missing/);
  assert.equal(existsSync(dir) && (await import("node:fs")).readdirSync(dir).length, 0);
});

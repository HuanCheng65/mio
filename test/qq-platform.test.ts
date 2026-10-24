import test from "node:test";
import assert from "node:assert/strict";
import { resolveAtMentions } from "../src/delivery/humanize";
import { getEmojiById, getEmojiByName } from "../src/emoji/lookup";

test("resolveAtMentions maps names to hex openids and leaves @#openid untouched", () => {
  const users = [{ name: "白川 理音", id: "EF11ED8C7B87648111CF06805F5EF5F8" }];
  assert.equal(resolveAtMentions("@白川理音 早", users), "@#EF11ED8C7B87648111CF06805F5EF5F8 早");
  assert.equal(
    resolveAtMentions("@#EF11ED8C7B87648111CF06805F5EF5F8 早", users),
    "@#EF11ED8C7B87648111CF06805F5EF5F8 早",
  );
});

test("vendored QQ face table resolves ids and overrides", () => {
  assert.equal(getEmojiById("0")?.name, "惊讶");
  assert.equal(getEmojiByName("太好笑")?.id, "387");
});

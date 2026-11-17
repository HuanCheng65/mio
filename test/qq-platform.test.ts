import test from "node:test";
import assert from "node:assert/strict";
import { getEmojiById, getEmojiByName } from "../src/emoji/lookup";

test("vendored QQ face table resolves ids and overrides", () => {
  assert.equal(getEmojiById("0")?.name, "惊讶");
  assert.equal(getEmojiByName("太好笑")?.id, "387");
});

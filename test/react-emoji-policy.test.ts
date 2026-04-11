import test from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_REACT_EMOJI_NAMES, findEmoji } from "../src/helpers";

test("react emoji whitelist contains 问号 but excludes 问号脸", () => {
  assert.ok(ALLOWED_REACT_EMOJI_NAMES.includes("问号"));
  assert.equal(ALLOWED_REACT_EMOJI_NAMES.includes("问号脸"), false);

  const q = findEmoji("问号", { allowedNames: ALLOWED_REACT_EMOJI_NAMES });
  assert.ok(q);
});

test("react emoji whitelist blocks names outside the configured list", () => {
  const blockedQFace = findEmoji("问号脸", { allowedNames: ALLOWED_REACT_EMOJI_NAMES });
  const blocked = findEmoji("龇牙", { allowedNames: ALLOWED_REACT_EMOJI_NAMES });
  assert.equal(blockedQFace, null);
  assert.equal(blocked, null);
});

import test from "node:test";
import assert from "node:assert/strict";
import { cosineSimilarity, EmbeddingService } from "../src/memory/embedding";

test("cosineSimilarity throws on dimension mismatch instead of returning 0", () => {
  assert.throws(() => cosineSimilarity([1, 0], [1, 0, 0]), /dimension mismatch/);
  assert.throws(() => cosineSimilarity([], [1]), /empty embedding/);
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
});

test("EmbeddingService refuses to embed before the model is verified", async () => {
  const service = new EmbeddingService({ getOpenAIProvider: () => ({}) } as any, { providerId: "p", modelName: "m" });
  await assert.rejects(service.embedBatch(["x"]), /一致性检查未通过/);
});

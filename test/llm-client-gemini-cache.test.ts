import test from "node:test";
import assert from "node:assert/strict";
import { LLMClient } from "../src/llm/client";

function createFakeGeminiProvider() {
  const fakeProvider = {
    lastRequest: null as any,
    models: {
      async generateContent(request: any) {
        fakeProvider.lastRequest = request;
        return {
          text: '{"ok":true}',
          usageMetadata: {},
        };
      },
    },
  };

  return fakeProvider;
}

function createProviderManager(fakeProvider: any) {
  return {
    getProviderConfig(providerId: string) {
      if (providerId === "gemini") {
        return { id: "gemini", type: "gemini" };
      }
      return null;
    },
    getGeminiProvider() {
      return fakeProvider;
    },
    getOpenAIProvider() {
      return null;
    },
  } as any;
}

test("LLMClient forwards cachedContent to Gemini generateContent", async () => {
  const fakeProvider = createFakeGeminiProvider();
  const client = new LLMClient(createProviderManager(fakeProvider));

  await client.chat(
    [{ role: "user", content: "hi" }],
    { providerId: "gemini", modelName: "gemini-3-flash-preview" },
    { cachedContent: "cachedContents/123" },
  );

  assert.equal(fakeProvider.lastRequest.config.cachedContent, "cachedContents/123");
});

test("LLMClient sends system messages as Gemini systemInstruction without cache", async () => {
  const fakeProvider = createFakeGeminiProvider();
  const client = new LLMClient(createProviderManager(fakeProvider));

  await client.chat(
    [
      { role: "system", content: "persona" },
      { role: "user", content: "new messages" },
    ],
    { providerId: "gemini", modelName: "gemini-3-flash-preview" },
  );

  assert.equal(fakeProvider.lastRequest.config.systemInstruction, "persona");
  assert.deepEqual(fakeProvider.lastRequest.contents, [
    { role: "user", parts: [{ text: "new messages" }] },
  ]);
});

test("LLMClient folds system text into a single leading user turn when using cachedContent", async () => {
  const fakeProvider = createFakeGeminiProvider();
  const client = new LLMClient(createProviderManager(fakeProvider));

  await client.chat(
    [
      { role: "system", content: "dynamic context" },
      { role: "user", content: "new messages" },
    ],
    { providerId: "gemini", modelName: "gemini-3-flash-preview" },
    { cachedContent: "cachedContents/123" },
  );

  assert.equal(fakeProvider.lastRequest.config.systemInstruction, undefined);
  assert.deepEqual(fakeProvider.lastRequest.contents, [
    { role: "user", parts: [{ text: "dynamic context" }, { text: "new messages" }] },
  ]);
});

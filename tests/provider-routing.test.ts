import test from "node:test";
import assert from "node:assert/strict";
import { providerAdapterFor } from "@/lib/provider-routing";

test("each provider family uses its own intended transport", () => {
  assert.equal(providerAdapterFor({ provider: "anthropic" }), "anthropic-native");
  assert.equal(providerAdapterFor({ provider: "google" }), "gemini-native");
  assert.equal(providerAdapterFor({ provider: "openai" }), "openai-compatible");
  assert.equal(providerAdapterFor({ provider: "deepseek" }), "openai-compatible");
  assert.equal(providerAdapterFor({ provider: "mistral" }), "openai-compatible");
  assert.equal(providerAdapterFor({ provider: "qwen" }), "openai-compatible");
});

test("Responses models and OpenAI Pro mode use the Responses API", () => {
  assert.equal(providerAdapterFor({ provider: "openai", api: "responses" }), "openai-responses");
  assert.equal(providerAdapterFor({ provider: "openai" }, true), "openai-responses");
});

test("Pro mode never changes a non-OpenAI provider transport", () => {
  assert.equal(providerAdapterFor({ provider: "google" }, true), "gemini-native");
  assert.equal(providerAdapterFor({ provider: "anthropic" }, true), "anthropic-native");
  assert.equal(providerAdapterFor({ provider: "xai" }, true), "openai-compatible");
});

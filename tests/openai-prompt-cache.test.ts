import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isOpenAIModernCacheModel,
  openAIPromptCacheRequestFields,
  openAISystemMessage,
  supportsOpenAIPromptCacheRetention,
} from "../src/lib/openai-prompt-cache";
import type { ModelInfo } from "../src/lib/models";

function fake(providerModel: string, provider: ModelInfo["provider"] = "openai"): ModelInfo {
  return {
    id: `${provider}:${providerModel}`,
    provider,
    providerModel,
    name: providerModel,
    minPlan: "PRO",
    vision: true,
    reasoning: true,
    cost: 2,
    modality: "chat",
    webSearch: false,
    status: "current",
  };
}

describe("openai-prompt-cache", () => {
  it("detects GPT-5.6 as modern cache family", () => {
    assert.equal(isOpenAIModernCacheModel(fake("gpt-5.6-sol")), true);
    assert.equal(isOpenAIModernCacheModel(fake("gpt-5.6-luna")), true);
    assert.equal(isOpenAIModernCacheModel(fake("gpt-5.5")), false);
    assert.equal(isOpenAIModernCacheModel(fake("gpt-4o")), false);
  });

  it("sets prompt_cache_key + options for GPT-5.6", () => {
    const fields = openAIPromptCacheRequestFields(fake("gpt-5.6-sol"), "conv_abc");
    assert.equal(fields.prompt_cache_key, "conv_abc");
    assert.deepEqual(fields.prompt_cache_options, { mode: "implicit", ttl: "30m" });
    assert.equal(fields.prompt_cache_retention, undefined);
  });

  it("sets extended retention for GPT-5.5", () => {
    assert.equal(supportsOpenAIPromptCacheRetention(fake("gpt-5.5")), true);
    const fields = openAIPromptCacheRequestFields(fake("gpt-5.5"), "conv_abc");
    assert.equal(fields.prompt_cache_key, "conv_abc");
    assert.equal(fields.prompt_cache_retention, "24h");
    assert.equal(fields.prompt_cache_options, undefined);
  });

  it("marks system message with explicit breakpoint on GPT-5.6", () => {
    const msg = openAISystemMessage(fake("gpt-5.6-terra"), "You are helpful.");
    assert.equal(msg.role, "system");
    assert.ok(Array.isArray(msg.content));
    const part = (msg.content as Array<{ prompt_cache_breakpoint?: { mode: string } }>)[0];
    assert.equal(part.prompt_cache_breakpoint?.mode, "explicit");
  });

  it("keeps plain system string on older models", () => {
    const msg = openAISystemMessage(fake("gpt-4o"), "You are helpful.");
    assert.equal(msg.content, "You are helpful.");
  });

  it("does nothing for non-OpenAI providers", () => {
    const fields = openAIPromptCacheRequestFields(fake("claude-sonnet-5", "anthropic"), "x");
    assert.deepEqual(fields, {});
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compatPromptCacheRequestFields,
  isOpenAIModernCacheModel,
  responsesPromptCacheRequestFields,
  withQwenCacheMarkers,
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
    agenticTools: true,
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
    assert.equal(isOpenAIModernCacheModel(fake("gpt-6-astra")), true);
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

  it("sends extended retention only to the documented models", () => {
    for (const id of ["gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.2", "gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5", "gpt-5-codex", "gpt-4.1", "gpt-4.1-2025-04-14"]) {
      assert.equal(supportsOpenAIPromptCacheRetention(fake(id)), true, id);
    }
    for (const id of ["gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.4-pro", "gpt-5.2-pro", "gpt-5.3-codex", "gpt-5-mini", "gpt-5-nano", "gpt-5-pro", "gpt-4.1-mini", "gpt-4o", "gpt-5.6-sol"]) {
      assert.equal(supportsOpenAIPromptCacheRetention(fake(id)), false, id);
      assert.equal(openAIPromptCacheRequestFields(fake(id), "k").prompt_cache_retention, undefined, id);
    }
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

  it("sends prompt_cache_key to Mistral and Meta on Chat Completions, nothing without a key", () => {
    assert.deepEqual(compatPromptCacheRequestFields(fake("mistral-medium-latest", "mistral"), "c1"), { prompt_cache_key: "c1" });
    assert.deepEqual(compatPromptCacheRequestFields(fake("muse-spark-1.3", "meta"), "c1"), { prompt_cache_key: "c1" });
    assert.deepEqual(compatPromptCacheRequestFields(fake("grok-4.6", "xai"), "c1"), {}, "xAI compat uses the header");
    assert.deepEqual(compatPromptCacheRequestFields(fake("mistral-medium-latest", "mistral"), undefined), {});
  });

  it("sends prompt_cache_key on the xAI and Meta Responses hosts, and 24h retention to Meta", () => {
    assert.deepEqual(responsesPromptCacheRequestFields(fake("grok-4.6", "xai"), "xai", "c1"), { prompt_cache_key: "c1" });
    assert.deepEqual(responsesPromptCacheRequestFields(fake("muse-spark-1.3", "meta"), "meta", "c1"), {
      prompt_cache_key: "c1",
      prompt_cache_retention: "24h",
    });
    assert.deepEqual(responsesPromptCacheRequestFields(fake("grok-4.6", "xai"), "xai", undefined), {});
    assert.deepEqual(
      responsesPromptCacheRequestFields(fake("gpt-5.5"), "openai", "c1"),
      openAIPromptCacheRequestFields(fake("gpt-5.5"), "c1")
    );
  });
});

describe("Qwen explicit cache markers", () => {
  type Msg = { role: string; content?: unknown; tool_call_id?: string };
  const marked = (messages: Msg[]) =>
    messages.flatMap((m, i) =>
      Array.isArray(m.content) && (m.content as Array<{ cache_control?: unknown }>).some((p) => p.cache_control) ? [i] : []
    );

  it("marks the system prompt and the newest message, as array content, without touching the history", () => {
    const history: Msg[] = [
      { role: "system", content: "rules" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:x" } }] },
    ];
    const out = withQwenCacheMarkers(history);
    assert.deepEqual(marked(out), [0, 3]);
    assert.deepEqual(out[0]!.content, [{ type: "text", text: "rules", cache_control: { type: "ephemeral" } }]);
    // The text part carries it, never the image.
    assert.deepEqual((out[3]!.content as Array<{ cache_control?: unknown }>)[0]!.cache_control, { type: "ephemeral" });
    assert.equal(typeof history[0]!.content, "string", "the loop's own history is unmarked");
    assert.deepEqual(marked(history), []);
  });

  it("keeps the conversation marker in front of the per-request date, and follows a tool round", () => {
    const date: Msg = { role: "system", content: "Today is 10 October." };
    const turn: Msg[] = [
      { role: "system", content: "rules" },
      { role: "user", content: "earlier" },
      { role: "assistant", content: "earlier answer" },
      date,
      { role: "user", content: "now" },
    ];
    // First round: the marker the NEXT turn can read ends before the date.
    assert.deepEqual(marked(withQwenCacheMarkers(turn, { dynamic: date })), [0, 2]);
    // A tool round: the newest tool result is marked too, so round N+1 reads round N.
    const round: Msg[] = [
      ...turn,
      { role: "assistant", content: null },
      { role: "tool", tool_call_id: "t1", content: "result" },
    ];
    const out = withQwenCacheMarkers(round, { dynamic: date });
    assert.deepEqual(marked(out), [0, 2, 6]);
    assert.ok(marked(out).length <= 4, "Qwen honours four markers");
  });

  it("short marks only the system prompt; none marks nothing", () => {
    const history: Msg[] = [{ role: "system", content: "rules" }, { role: "user", content: "chunk" }];
    assert.deepEqual(marked(withQwenCacheMarkers(history, { mode: "short" })), [0]);
    assert.deepEqual(marked(withQwenCacheMarkers(history, { mode: "none" })), []);
  });
});

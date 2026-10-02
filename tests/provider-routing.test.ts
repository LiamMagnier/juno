import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { providerReceivesDocumentBytes } from "@/lib/attachment-bytes";
import { MODEL_LIST } from "@/lib/models";
import { openAIResponsesEnabled, PROVIDER_ADAPTERS, providerAdapterFor } from "@/lib/provider-routing";

test("each provider family uses its own intended transport", () => {
  assert.equal(providerAdapterFor({ provider: "anthropic" }), "anthropic-native");
  assert.equal(providerAdapterFor({ provider: "google" }), "gemini-native");
  assert.equal(providerAdapterFor({ provider: "deepseek" }), "openai-compatible");
  assert.equal(providerAdapterFor({ provider: "mistral" }), "openai-compatible");
  assert.equal(providerAdapterFor({ provider: "qwen" }), "openai-compatible");
});

test("every OpenAI model uses the Responses API (SPEC §5.2 item 1)", () => {
  // GPT-6 Astra cannot call a tool on /chat/completions at all, and Sol, Luna
  // and the GPT-5.6 line only at effort "none".
  assert.equal(providerAdapterFor({ provider: "openai" }), "openai-responses");
  assert.equal(providerAdapterFor({ provider: "openai", id: "openai:gpt-6-astra" }), "openai-responses");
  assert.equal(providerAdapterFor({ provider: "openai", api: "responses" }), "openai-responses");
  assert.equal(providerAdapterFor({ provider: "openai" }, true), "openai-responses");
});

test("OPENAI_RESPONSES=0 keeps the old routing for a proxy without /responses", () => {
  const saved = process.env.OPENAI_RESPONSES;
  process.env.OPENAI_RESPONSES = "0";
  try {
    assert.equal(openAIResponsesEnabled(), false);
    assert.equal(providerAdapterFor({ provider: "openai" }), "openai-compatible");
    // The Responses-only snapshots and Pro mode have no other route.
    assert.equal(providerAdapterFor({ provider: "openai", api: "responses" }), "openai-responses");
    assert.equal(providerAdapterFor({ provider: "openai" }, true), "openai-responses");
    // Only OpenAI reads it.
    assert.equal(providerAdapterFor({ provider: "xai", id: "xai:grok-4.7" }), "xai-responses");
  } finally {
    if (saved === undefined) delete process.env.OPENAI_RESPONSES;
    else process.env.OPENAI_RESPONSES = saved;
  }
  assert.equal(openAIResponsesEnabled(), saved !== "0");
});

test("Grok is served on xAI's Responses surface, except a slug its record keeps on compat", () => {
  assert.equal(providerAdapterFor({ provider: "xai", id: "xai:grok-4.7" }), "xai-responses");
  // Built-in search only, and no Chat Completions: Responses is its only route.
  assert.equal(providerAdapterFor({ provider: "xai", id: "xai:grok-4.20-multi-agent-0309" }), "xai-responses");
  // An unknown Grok gets its lab's row.
  assert.equal(providerAdapterFor({ provider: "xai" }), "xai-responses");
  // Slug unconfirmed (probe P14): left where it was.
  assert.equal(providerAdapterFor({ provider: "xai", id: "xai:grok-4.1-fast" }), "openai-compatible");
  // The catalog entry's own override is honoured.
  assert.equal(providerAdapterFor({ provider: "xai", id: "xai:grok-4.7", tools: { responses: false } }), "openai-compatible");
});

test("Pro mode never changes a non-OpenAI provider transport", () => {
  assert.equal(providerAdapterFor({ provider: "google" }, true), "gemini-native");
  assert.equal(providerAdapterFor({ provider: "anthropic" }, true), "anthropic-native");
  assert.equal(providerAdapterFor({ provider: "xai", id: "xai:grok-4.7" }, true), "xai-responses");
  assert.equal(providerAdapterFor({ provider: "deepseek" }, true), "openai-compatible");
});

test("who receives a PDF's bytes follows the transport that serves the model", () => {
  const vision = { vision: true } as const;
  // Every vision OpenAI model reads a scan itself now, as `input_file`.
  assert.equal(providerReceivesDocumentBytes({ provider: "openai", ...vision }), true);
  assert.equal(providerReceivesDocumentBytes({ provider: "openai", vision: false }), false);
  // xAI's Responses surface has not been shown to take `input_file`.
  assert.equal(providerReceivesDocumentBytes({ provider: "xai", id: "xai:grok-4.7", ...vision }), false);
  assert.equal(providerReceivesDocumentBytes({ provider: "anthropic", vision: false }), true);
  assert.equal(providerReceivesDocumentBytes({ provider: "deepseek", ...vision }), false);
});

test("every transport a catalog model is routed to is a listed adapter", () => {
  for (const model of MODEL_LIST.filter((m) => m.modality === "chat")) {
    assert.ok(PROVIDER_ADAPTERS.includes(providerAdapterFor(model)), model.id);
  }
});

/*
 * `streamChat` (src/lib/llm.ts, lane 3a) dispatches on this function's value.
 * The switch in the WS0 llm.ts this branch carries has no default, so a value
 * with no case streams nothing at all: no text, no finish, no error. Every
 * Grok model but grok-4.1-fast is such a value here ("xai-responses"), so a
 * Grok turn is empty on this branch alone. The fix is lane 3a's file: a
 * `case "xai-responses"` that calls `streamOpenAIResponses` (it picks the xAI
 * dialect from the model's provider), and a `never` default so the next
 * adapter value fails typecheck instead of streaming nothing.
 *
 * That makes it a precondition of the WS3a → WS3b merge (SPEC §12.1), and this
 * test enforces it there. It turns on as soon as lane 3a's adapter loops are
 * in the tree, which is the point from which the merged llm.ts is lane 3a's,
 * and it fails that merge's gate until the switch is complete.
 */
const LANE_3A_IN_TREE = ["src/lib/llm/anthropic-loop.ts", "src/lib/llm/gemini-loop.ts"].some((file) => existsSync(file));

test(
  "streamChat has a case for every adapter and fails typecheck on a new one",
  {
    skip: LANE_3A_IN_TREE
      ? false
      : "lane 3a's llm.ts is not in this tree; the WS3a → WS3b merge adds `case \"xai-responses\"` and a `never` default (SPEC §5.0)",
  },
  () => {
    const llm = readFileSync("src/lib/llm.ts", "utf8");
    for (const adapter of PROVIDER_ADAPTERS) assert.match(llm, new RegExp(`case "${adapter}":`), adapter);
    assert.match(llm, /:\s*never\s*=\s*adapter\b/, "the switch's default narrows `adapter` to never");
  },
);

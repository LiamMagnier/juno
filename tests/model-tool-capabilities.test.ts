import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { toolCapabilitiesFor } from "@/lib/model-tools";

/*
 * The per-model tool capabilities (SPEC §5.6).
 *
 * WS0 filled `toolCapabilitiesFor` from the provider capability audit; these
 * are spot checks of that table, one per rule it follows. WS3b owns this file
 * and grows it into the §13.1 test (a record for every current model, and a
 * snapshot of the table) as the probes settle the conservative values.
 */

test("the capabilities stay importable by the composer", () => {
  const source = readFileSync(path.join(process.cwd(), "src/lib/model-tools.ts"), "utf8");
  assert.doesNotMatch(source, /^import "server-only";/m);
});

test("toolCapabilitiesFor reads the lab row, the model's own rules and the overrides", () => {
  const caps = (provider: Parameters<typeof toolCapabilitiesFor>[0]["provider"], id: string, extra: object = {}) =>
    toolCapabilitiesFor({ provider, id: `${provider}:${id}`, ...extra });
  assert.equal(caps("anthropic", "claude-opus-5-5").anthropicSearchVersion, "20260318");
  assert.equal(caps("anthropic", "claude-haiku-4-5").anthropicSearchVersion, "20250305");
  assert.equal(caps("openai", "gpt-6-astra").chatCompletions, false);
  assert.equal(caps("openai", "gpt-5.5-pro", { api: "responses" }).chatCompletions, false);
  assert.equal(caps("openai", "gpt-5").hostedSearchMinEffort, "low");
  assert.equal(caps("google", "gemini-3.8-flash").nativeSearch, true);
  assert.equal(caps("google", "gemini-2.5-pro").nativeSearch, false, "pre-Gemini-3 keeps its functions");
  assert.equal(caps("xai", "grok-4.20-multi-agent-0309").supported, false);
  assert.equal(caps("deepseek", "deepseek-v4-pro").replay, "must");
  assert.equal(caps("meta", "muse-spark-1.3").finalRound, "omit_tools");
  assert.equal(caps("mistral", "mistral-large-latest").userAfterTool, false);
  assert.equal(caps("qwen", "qwen3.8-max").parallel, "opt_in");
  assert.equal(caps("moonshot", "kimi-k9-unreleased").replay, "must", "an unlisted model gets its lab's row");
  assert.equal(caps("openai", "gpt-6-sol", { tools: { maxTools: 32 } }).maxTools, 32, "the catalog override wins");
});

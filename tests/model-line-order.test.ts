import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_LIST } from "@/lib/models";
import { sortModelsForDisplay } from "@/lib/model-metrics";

/*
 * A lab's product lines in the owner's order, most capable first, where the
 * version numbers and release dates would order them otherwise
 * (model-metrics.ts, LINE_RANK).
 */

const ids = (models: { id: string }[]) => models.map((m) => m.id);

test("Gemini 4 lists Carbon, then Argon, then Hydrogen (owner, 16 Nov 2026)", () => {
  const gemini4 = MODEL_LIST.filter((m) => m.provider === "google" && /^google:gemini-4-/.test(m.id));
  assert.deepEqual(ids(sortModelsForDisplay(gemini4)), ["google:gemini-4-carbon", "google:gemini-4-argon", "google:gemini-4-hydrogen"]);
  // Whatever order they arrive in: Hydrogen is the newest release, which a date sort put first.
  assert.deepEqual(ids(sortModelsForDisplay([...gemini4].reverse())), ["google:gemini-4-carbon", "google:gemini-4-argon", "google:gemini-4-hydrogen"]);
});

test("Gemini 4 still leads Google's current text models, above Gemini 3.x", () => {
  const google = sortModelsForDisplay(MODEL_LIST.filter((m) => m.provider === "google" && (m.modality ?? "chat") === "chat" && m.status === "current"));
  assert.deepEqual(ids(google).slice(0, 3), ["google:gemini-4-carbon", "google:gemini-4-argon", "google:gemini-4-hydrogen"]);
});

test("Anthropic's lines keep Fable, Opus, Sonnet, Haiku", () => {
  const anthropic = sortModelsForDisplay(MODEL_LIST.filter((m) => m.provider === "anthropic" && m.status === "current"));
  const families = [...new Set(anthropic.map((m) => m.family))].filter((f) => ["fable", "opus", "sonnet", "haiku"].includes(f ?? ""));
  assert.deepEqual(families, ["fable", "opus", "sonnet", "haiku"].filter((f) => families.includes(f)));
});

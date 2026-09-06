import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveModel } from "../src/lib/models";
import { tokenRate } from "../src/lib/pricing";
import { defaultReasoning, reasoningCaps } from "../src/lib/model-metrics";

function model(id: string) { const value = resolveModel(id); assert.ok(value, id); return value; }

test("September models retain exact provider IDs and current status", () => {
  for (const id of ["anthropic:claude-fable-5-1", "google:gemini-3.8-flash", "xai:grok-4.6"]) {
    const entry = model(id);
    assert.equal(entry.id, id);
    assert.equal(entry.status, "current");
  }
});
test("Fable 5.1 cache discount does not reprice Fable 5", () => {
  assert.deepEqual(tokenRate(model("anthropic:claude-fable-5-1")), {
    input: 10, output: 50, cacheRead: 0.25, cacheWrite: 20, cacheWrite5m: 12.5, cacheWrite1h: 20,
  });
  assert.equal(tokenRate(model("anthropic:claude-fable-5")).cacheRead, 1);
});
test("Gemini Flash promotional rates include cache reads", () => {
  for (const version of ["3.6", "3.7", "3.8"]) {
    const rate = tokenRate(model(`google:gemini-${version}-flash`));
    assert.equal(rate.input, 0.75);
    assert.equal(rate.output, 3.75);
    assert.ok(Math.abs(rate.cacheRead - 0.075) < 1e-9);
  }
});
test("Fable and Grok default to high with model-specific effort ladders", () => {
  for (const id of ["anthropic:claude-fable-5-1", "xai:grok-4.6"]) {
    assert.equal(defaultReasoning(model(id)), "high");
  }
  assert.notDeepEqual(reasoningCaps(model("xai:grok-4.6")), reasoningCaps(model("xai:grok-4.5")));
});

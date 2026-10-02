import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { CURATED_CHAT_MODELS } from "@/lib/models";
import { providerAdapterFor } from "@/lib/provider-routing";
import {
  COVERAGE_RUNTIMES,
  COVERAGE_SURFACES,
  MODEL_CAPABILITIES,
  buildCoverage,
  isCompatible,
  recordModelVerdict,
  renderCoverageTables,
  validateCoverage,
  type CatalogModel,
  type ToolRuntimeCoverage,
} from "@/lib/tool-runtime-coverage";

/*
 * TOOL_RUNTIME_DESIGN.md §6.11: every current model has a verdict per
 * capability, every surface × runtime cell is filled, untested cells say so,
 * and no untested model is marked compatible. The checked-in record must hold
 * against today's catalog, and the generated doc tables must match it.
 */

function catalog(): CatalogModel[] {
  return CURATED_CHAT_MODELS.filter(
    (m) => (m.status ?? "current") === "current" && ((m as { modality?: string }).modality ?? "chat") === "chat",
  ).map((m) => ({ id: m.id, provider: m.provider, adapter: providerAdapterFor(m), vision: m.vision, agenticTools: m.agenticTools }));
}

const record = JSON.parse(readFileSync("contracts/capabilities/tool-runtime-coverage.json", "utf8")) as ToolRuntimeCoverage;

test("the checked-in record holds against the current catalog", () => {
  assert.deepEqual(validateCoverage(record, catalog()), []);
  assert.equal(record.models.length, catalog().length);
  assert.equal(record.matrix.length, COVERAGE_SURFACES.length * COVERAGE_RUNTIMES.length);
});

test("it is exactly what the generator would write (no hand edits, no drift)", () => {
  const rebuilt = buildCoverage(catalog(), record);
  assert.equal(`${JSON.stringify(rebuilt, null, 2)}\n`, readFileSync("contracts/capabilities/tool-runtime-coverage.json", "utf8"));
  const doc = readFileSync("docs/rework/TOOL_RUNTIME_COVERAGE.md", "utf8");
  const tables = renderCoverageTables(rebuilt);
  assert.ok(doc.includes(tables.models), "the models table is stale: run scripts/generate-tool-runtime-coverage.ts");
  assert.ok(doc.includes(tables.matrix), "the matrix table is stale: run scripts/generate-tool-runtime-coverage.ts");
});

test("no model is compatible today, and nothing untested is", () => {
  for (const model of record.models) {
    for (const { key } of MODEL_CAPABILITIES) {
      const cell = model.verdicts[key];
      assert.ok(cell, `${model.id} ${key}`);
      if (cell.verdict === "untested") assert.equal(model.compatible, false);
    }
    assert.equal(model.compatible, false, `${model.id}: no live evidence exists yet`);
  }
});

test("the catalog's agenticTools guess never makes a model compatible", () => {
  const guessed = record.models.find((m) => m.catalogAgenticTools);
  assert.ok(guessed);
  assert.equal(guessed.compatible, false);
  assert.equal(guessed.verdicts.roundTrip.verdict, "untested");
});

test("a model without vision cannot carry a tool-image verdict", () => {
  for (const model of record.models.filter((m) => !m.vision)) {
    assert.equal(model.verdicts.toolImages.verdict, "not_applicable", model.id);
  }
});

test("compatibility needs both live round trips, each with a date and evidence", () => {
  const id = record.models[0].id;
  assert.throws(() => recordModelVerdict(record, id, "roundTrip", { verdict: "verified" }), /date and evidence/);
  const one = recordModelVerdict(record, id, "roundTrip", { verdict: "verified", date: "2026-10-02", evidence: "probe:run_1", probeVersion: 2 });
  assert.equal(one.models[0].compatible, false, "a round trip alone is not enough");
  const both = recordModelVerdict(one, id, "runCodeE2E", { verdict: "verified", date: "2026-10-02", evidence: "ToolRun cl_1", probeVersion: 2 });
  assert.equal(both.models[0].compatible, true);
  assert.equal(isCompatible({ ...both.models[0].verdicts, runCodeE2E: { verdict: "verified", date: "2026-10-01", evidence: "x", probeVersion: 1 } }), false, "an old probe does not count");
  // Recorded evidence survives a regeneration.
  const regenerated = buildCoverage(catalog(), both);
  assert.equal(regenerated.models.find((m) => m.id === id)?.compatible, true);
});

test("the checker catches a forged compatible flag and a missing model", () => {
  const forged = { ...record, models: record.models.map((m, i) => (i === 0 ? { ...m, compatible: true } : m)) };
  assert.ok(validateCoverage(forged, catalog()).some((p) => /marked compatible without verified/.test(p)));
  const missing = { ...record, models: record.models.slice(1) };
  assert.ok(validateCoverage(missing, catalog()).some((p) => /no coverage row/.test(p)));
});

test("the realtime relay is unsupported everywhere, with the test that proves it", () => {
  for (const cell of record.matrix.filter((c) => c.surface === "voice_realtime")) {
    assert.equal(cell.verdict, "unsupported");
    assert.equal(cell.evidence, "relay/tests/voice-tool-limit.test.ts");
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deterministicPart, runMemorySuite, type SuiteResult } from "@/lib/memory-eval";

/*
 * The memory evaluation suite as a gate (src/lib/memory-eval.ts).
 *
 * Offline runs are exact, latency aside, so `current` in the record is an
 * oracle: a change that moves a number re-records it in the same commit
 * (`npm run memory:bench -- --suite --record`). And the current rules may not
 * do worse than the baseline measured before the 2026-10-04 memory vertical.
 */

const record = JSON.parse(readFileSync(new URL("./fixtures/memory-eval-record.json", import.meta.url), "utf8")) as {
  baseline: { results: Omit<SuiteResult, "latency"> };
  current: { results: Omit<SuiteResult, "latency"> };
};

test("a fresh suite run matches the recorded numbers exactly", async () => {
  assert.deepEqual(deterministicPart(await runMemorySuite()), record.current.results);
});

test("no evaluated dimension regresses from the baseline", () => {
  const before = record.baseline.results;
  const now = record.current.results;
  for (const setting of ["live", "re-read"] as const) {
    assert.ok(now.lifecycle[setting].recall >= before.lifecycle[setting].recall);
    assert.ok(now.lifecycle[setting].precision >= before.lifecycle[setting].precision);
    assert.ok(now.lifecycle[setting].stale <= before.lifecycle[setting].stale);
    assert.ok(now.lifecycle[setting].leaks <= before.lifecycle[setting].leaks);
  }
  assert.ok(now.corrections.passed >= before.corrections.passed);
  assert.ok(now.corrections.passedReread >= before.corrections.passedReread);
  assert.ok(now.corrections.falseContradictions <= before.corrections.falseContradictions);
  assert.ok(now.falseMemory.believedNotTrue <= before.falseMemory.believedNotTrue);
  assert.ok(now.scope.leaks <= before.scope.leaks);
  assert.ok(now.sensitive.storedWithoutOptIn <= before.sensitive.storedWithoutOptIn);
  assert.ok(now.summary.staleInjectedLifecycle <= before.summary.staleInjectedLifecycle);
  assert.ok(now.tokens.max <= now.tokens.budget);
});

test("hard floors: nothing invented, nothing leaked, nothing sensitive stored without opt-in", () => {
  const now = record.current.results;
  assert.equal(now.falseMemory.dreamInvented, 0);
  assert.equal(now.scope.leaks, 0);
  assert.equal(now.sensitive.storedWithoutOptIn, 0);
  assert.equal(now.summary.staleInjectedLifecycle, 0);
  assert.equal(now.consolidation.mergedWhenDifferent, 0);
  assert.equal(now.corrections.falseContradictions, 0);
});

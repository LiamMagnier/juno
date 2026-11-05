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

test("§10.3 floors: no inappropriate personalisation, no deletion leaks, typed corrections settle", () => {
  const now = record.current.results;
  assert.equal(now.personalisation.inappropriate, 0);
  assert.equal(now.personalisation.appropriateUsed, now.personalisation.appropriate, "the gates do not simply refuse");
  assert.equal(now.personalisation.typedKept, now.personalisation.typed);
  assert.ok(now.personalisation.legacyInappropriate > 0, "the baseline the gates are measured against is real");
  assert.equal(now.deletion.leaks, 0);
  assert.ok(now.deletion.legacyLeaks > 0);
  assert.equal(now.manual.passed, now.manual.cases);
  assert.equal(now.manual.duplicatesLeft, 0);
  assert.ok(now.manual.legacyPassed < now.manual.cases);
});

test("§10.3 floors: a sensitive fact a request makes relevant without naming it is still used", () => {
  // A typed peanut allergy for "suggest a dinner recipe", inferred diabetes
  // for "plan my meals this week" — in the lexical fallback (no embedder, or
  // it failed), with semantic evidence that singles the fact out, and with
  // semantic evidence that singles nothing out.
  const implicit = record.current.results.personalisation.implicit;
  assert.ok(implicit.expected >= 16, "the case set is the one recorded");
  assert.equal(implicit.lexicalUsed, implicit.expected, "lexical fallback");
  assert.equal(implicit.semanticStandoutUsed, implicit.expected, "semantic, the fact stands out");
  assert.equal(implicit.semanticFlatUsed, implicit.expected, "semantic, nothing stands out");
  assert.equal(implicit.distractorsUsed, 0, "a sensitive fact unrelated to food is not handed to a food request");
  assert.equal(implicit.revokedInferredUsed, 0, "a switched-off topic's inferred facts stay out, relevant or not");
  assert.equal(implicit.revokedTypedKept, implicit.revokedTyped, "typed ones stay");
  assert.ok(implicit.legacyLexicalUsed < implicit.expected, "the rules before 2026-10-25 really missed some");
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

import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { auditEvidence, splitPassages } from "@/lib/research/claim-analysis";

/*
 * A performance guard on the deterministic citation audit. Every figure of a
 * claim is compared with every figure of a passage, and the same passage is
 * audited for many claims: re-deriving a passage's words and clause edges
 * per pair once took ~3 s per call on a 60k-character page (and ~27 s for
 * ten claims on it) where the pre-audit code took well under 100 ms. The
 * bounds are deliberately generous — ten to twenty times what an idle laptop
 * needs — so a loaded CI machine passes and a return to quadratic work does
 * not.
 */

/** A long financial page: 600 sentences, each with a quarter, a year, two figures and a negation. */
function longPage(variant = 0): string {
  return Array.from(
    { length: 600 },
    (_, i) =>
      `In Q${(i % 4) + 1} ${2000 + (i % 25)}, segment ${i} revenue was $${(i * 1.37 + variant).toFixed(1)} million, up ${i % 30}% on the prior year, while costs did not rise.`
  ).join(" ");
}

test("one audit of a 60k-character passage stays far from quadratic", () => {
  const page = longPage(1);
  assert.ok(page.length > 60_000);
  const started = performance.now();
  const result = auditEvidence({ claim: "Segment 7 revenue was $9,999 million in 2003, up 7%.", passage: page });
  const elapsed = performance.now() - started;
  assert.ok(result.ceiling < 1, "the audit still reads the page: the figure is not on it");
  assert.ok(elapsed < 1500, `one audit of a ${page.length}-character passage took ${elapsed.toFixed(0)} ms`);
});

test("auditing many claims against the same long passage reuses what the passage says", () => {
  const page = longPage(2);
  const started = performance.now();
  for (let i = 0; i < 10; i++) {
    auditEvidence({
      claim: `Segment ${i} revenue was $${(i + 3).toFixed(1)} million in 2003, up ${i}%.`,
      passage: page,
    });
  }
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 3000, `ten audits against one long passage took ${elapsed.toFixed(0)} ms`);
});

test("auditing claims against a page split into passages stays cheap", () => {
  const body = Array.from(
    { length: 300 },
    (_, i) => `In Q${(i % 4) + 1} ${2000 + (i % 25)}, segment ${i} revenue was $${(i * 1.37).toFixed(1)} million, up ${i % 30}% on the prior year, while costs did not rise.`
  ).reduce((acc, s, i) => acc + s + (i % 6 === 5 ? "\n\n" : " "), "");
  const passages = splitPassages(body, { maxPassages: 24 });
  const started = performance.now();
  let calls = 0;
  for (let i = 0; i < 40; i++) {
    for (const p of passages) {
      auditEvidence({ claim: `Segment ${i} revenue was $${(i + 3).toFixed(1)} million in 2003, up ${i}%.`, passage: p.text });
      calls += 1;
    }
  }
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 3000, `${calls} audits on split passages took ${elapsed.toFixed(0)} ms`);
});

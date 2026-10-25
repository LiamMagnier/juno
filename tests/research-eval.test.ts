import test from "node:test";
import assert from "node:assert/strict";
import { RESEARCH_CITATION_CASES } from "@/lib/eval/research-citation-cases";
import {
  STOCK_JUDGES,
  renderScorecard,
  scoreResearchCitationEval,
  type Scorecard,
} from "@/lib/eval/research-citations";
import { serverOnlyIn } from "./fixtures/server-only-graph";

/*
 * The research citation eval set (master brief 7.1): whole reports, run through
 * the production citation audit end to end, scored against a human label for
 * every claim. See src/lib/eval/research-citation-cases.ts for how the labels
 * were written and src/lib/eval/research-citations.ts for what runs.
 *
 * The thresholds are the measured behaviour of this build on this set, at or
 * above the program's §8.3 bar where one exists (95% supported precision).
 * They are a floor against regression, not a claim about live-model accuracy:
 * the judges here are stubs that model a small model's failure mode, so what
 * they measure is the deterministic audit's contribution. `npm run
 * eval:research` prints the full scorecard; a live-model run is not part of
 * this suite.
 */

const cards = new Map<string, Promise<Scorecard>>();
function card(name: keyof typeof STOCK_JUDGES): Promise<Scorecard> {
  let pending = cards.get(name);
  if (!pending) {
    pending = scoreResearchCitationEval(RESEARCH_CITATION_CASES, STOCK_JUDGES[name], name);
    cards.set(name, pending);
  }
  return pending;
}

test("the eval harness runs without a database, a network or server-only code", () => {
  assert.deepEqual(serverOnlyIn("src/lib/eval/research-citations.ts"), []);
});

test("the eval set is big enough, fully labelled, and covers every verdict and flag", async () => {
  const m = await card("optimistic");
  assert.ok(RESEARCH_CITATION_CASES.length >= 7, `${RESEARCH_CITATION_CASES.length} reports`);
  assert.ok(m.labelled >= 35, `${m.labelled} labelled claims; the set needs at least 35 to measure anything`);
  assert.equal(new Set(RESEARCH_CITATION_CASES.map((c) => c.id)).size, RESEARCH_CITATION_CASES.length, "case ids are unique");
  // Every claim the audit extracts has a human label, and every label names
  // exactly one claim: precision is measured over the whole report, not over
  // the claims someone chose to label.
  assert.deepEqual(m.unlabelled, [], "extracted claims nobody labelled");
  assert.deepEqual(m.unmatched, [], "labels that match no claim, or several");
  const expectations = RESEARCH_CITATION_CASES.flatMap((c) => c.expectations);
  for (const label of ["supported", "partially supported", "unsupported", "contradicted", "unverified"] as const) {
    assert.ok(expectations.some((e) => e.label === label), `no claim is labelled ${label}`);
  }
  assert.ok(expectations.some((e) => e.contested), "no contested claim");
  assert.ok(expectations.some((e) => e.stale), "no stale claim");
  assert.ok(expectations.some((e) => e.unresolved?.length), "no invented citation");
  const states = new Set((await card("optimistic")).results.flatMap((r) => r.readStates));
  for (const state of ["opened", "search_text", "search_preview"] as const) {
    assert.ok(states.has(state), `no source the ledger reads as ${state}`);
  }
});

for (const name of ["optimistic", "credulous"] as const) {
  test(`${name} judge: supported precision clears the 95% bar on whole reports`, async () => {
    const m = await card(name);
    console.log(renderScorecard(m));
    assert.ok(m.supportedPrecision >= 0.95, renderScorecard(m));
    assert.ok(m.supportedRecall >= 0.9, `recall collapsed — the audit is over-firing\n${renderScorecard(m)}`);
  });

  test(`${name} judge: labels match the human judgement`, async () => {
    const m = await card(name);
    assert.ok(m.lenientAccuracy >= 0.95, renderScorecard(m));
    assert.ok(m.strictAccuracy >= 0.9, renderScorecard(m));
  });

  test(`${name} judge: contradictions are called contradictions, and nothing else is`, async () => {
    const m = await card(name);
    // Precision first: a false contradiction rewrites an honest sentence as
    // "Conflicting evidence:" — the accusation this audit must never make.
    assert.equal(m.contradictionPrecision, 1, renderScorecard(m));
    // Recall is reported honestly rather than rounded up: a date the source
    // states differently is still read as "not established" (unsupported),
    // not as a contradiction. Every such miss is lenient — never "supported".
    assert.ok(m.contradictionRecall >= 0.6, renderScorecard(m));
    for (const result of m.results) {
      for (const claim of result.claims) {
        if (claim.expected?.label !== "contradicted" || claim.actual.label === "contradicted") continue;
        assert.ok(claim.lenient || claim.falseSupport, `${claim.claim}: ${claim.actual.label}`);
      }
    }
  });

  test(`${name} judge: every audit miss that reads "supported" still shows the reader the disagreement`, async () => {
    const m = await card(name);
    assert.ok(m.falseSupports.length <= 1, renderScorecard(m));
    for (const miss of m.falseSupports) {
      assert.equal(miss.actual.contested, true, `${miss.claim} is marked supported with nothing on screen to question it`);
    }
  });

  test(`${name} judge: stale, contested and invented-citation flags all hold`, async () => {
    const m = await card(name);
    assert.deepEqual(
      m.flagFailures.map((f) => `${f.caseId}: ${f.claim}`),
      [],
      renderScorecard(m)
    );
  });
}

for (const name of ["optimistic", "credulous", "unavailable"] as const) {
  test(`${name} judge: the repair never invents a citation and never leaves one that names nothing`, async () => {
    const m = await card(name);
    assert.deepEqual(m.integrityFailures, []);
    for (const result of m.results) {
      assert.deepEqual(result.integrity.addedMarkers, [], `${result.caseId}: markers added`);
      assert.deepEqual(result.integrity.unresolvedRemaining, [], `${result.caseId}: markers to nothing survived`);
      assert.equal(result.integrity.linksToUncitedSources, 0, `${result.caseId}: a claim was linked to a source it never cited`);
    }
  });
}

test("with no model, nothing is supported, contradictions the text settles survive, and only evidence-free claims are unsupported", async () => {
  const offline = await card("unavailable");
  const online = await card("optimistic");
  const all = offline.results.flatMap((r) => r.claims);
  assert.equal(all.filter((c) => c.actual.label === "supported").length, 0);
  // Every contradiction the optimistic run settled from the text alone is
  // still found with no model at all.
  const onlineContradicted = new Set(
    online.results.flatMap((r) => r.claims).filter((c) => c.actual.label === "contradicted").map((c) => c.claim)
  );
  const offlineContradicted = new Set(all.filter((c) => c.actual.label === "contradicted").map((c) => c.claim));
  for (const claim of onlineContradicted) assert.ok(offlineContradicted.has(claim), `${claim} lost its contradiction offline`);
  // "Unsupported" with no judge is only honest where there was nothing to
  // check: no citation, or citations that name no source.
  for (const claim of all.filter((c) => c.actual.label === "unsupported" || c.actual.label === "partially supported")) {
    const expected = claim.expected!;
    assert.ok(
      expected.label === "unsupported" && (claim.actual.unresolved.length > 0 || !/\[\d+\]/.test(claim.claim)),
      `${claim.claim} was marked ${claim.actual.label} with no model to judge it`
    );
  }
});

test("a claim judged only against a search preview is unverified; against full search text it is unsupported", async () => {
  const m = await card("optimistic");
  const saas = m.results.find((r) => r.caseId === "saas-pricing-previews")!;
  assert.deepEqual(saas.readStates, ["opened", "search_preview", "search_text"]);
  const preview = saas.claims.find((c) => c.claim.includes("mobile app 4.8"))!;
  assert.equal(preview.actual.label, "unverified");
  assert.equal(preview.actual.previewOnly, true);
  const fullText = saas.claims.find((c) => c.claim.includes("140 engineers"))!;
  assert.equal(fullText.actual.label, "unsupported");
  assert.equal(fullText.actual.previewOnly, false);
});

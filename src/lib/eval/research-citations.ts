/**
 * The research citation eval: runs whole reports through the production
 * citation audit and scores it against human labels.
 *
 * What runs is the code a real research run uses, in the order it uses it —
 * the source ledger (source-provenance.ts) deciding which texts are previews,
 * `splitPassages` cutting each body as `storeCorpus` does, then
 * `selectClaimsForAudit` + `auditClaims` (citation-audit-core.ts) for
 * extraction, linking, ranking, judging, resolution, contested and rival
 * detection and freshness, then `repairReportFromClaims` for what the reader
 * is finally shown. Only the database writes are skipped, and they decide
 * nothing.
 *
 * The judge is injected, and the stock judges are deliberately NOT oracles.
 * If a stub returned the fixture's own label, the eval would measure the stub.
 * `optimistic` is the realistic failure mode of a small utility model (shared
 * vocabulary reads as support); `credulous` rubber-stamps everything; and
 * `unavailable` is the outage path. Precision under the first two is precision
 * the deterministic audit contributes — the part this repository owns. A live
 * model judge can be passed in by a caller that has one; nothing here needs a
 * network or a database.
 *
 * Pure and free of `server-only`.
 */

import {
  repairReportFromClaims,
  splitPassages,
  tokenCoverage,
  type CitationJudge,
  type SupportLabel,
} from "@/lib/research/claim-analysis";
import { auditClaims, selectClaimsForAudit, type AuditedClaim } from "@/lib/research/citation-audit-core";
import { isPreviewOnly, openedUrlsFrom, sourceReadState, type SourceReadState } from "@/lib/research/source-provenance";
import type { EvalCase, EvalExpectation } from "@/lib/eval/research-citation-cases";

/** The realistic small-model failure mode: shared vocabulary reads as support. */
export const optimisticJudge: CitationJudge = async ({ claim, passage }) => {
  const coverage = tokenCoverage(claim, passage);
  return coverage >= 0.2
    ? { verdict: "supported", strength: 0.85, reason: "shares subject matter" }
    : { verdict: "unsupported", strength: 0.1, reason: "unrelated" };
};

/** The worst case: a judge that rubber-stamps every pair it is shown. */
export const credulousJudge: CitationJudge = async () => ({ verdict: "supported", strength: 0.98 });

/** No model answered. */
export const unavailableJudge: CitationJudge = async () => null;

export const STOCK_JUDGES = {
  optimistic: optimisticJudge,
  credulous: credulousJudge,
  unavailable: unavailableJudge,
} as const;

export type StockJudgeName = keyof typeof STOCK_JUDGES;

/** As production: `MAX_PASSAGES_PER_SOURCE` in claims.ts. */
const PASSAGES_PER_SOURCE = 24;

export interface ClaimResult {
  caseId: string;
  claim: string;
  expected: EvalExpectation | null;
  actual: {
    label: SupportLabel;
    supportStrength: number | null;
    contested: boolean;
    stale: boolean;
    unresolved: number[];
    previewOnly: boolean;
    reasons: string[];
  };
  /** Primary label matched. */
  strict: boolean;
  /** Primary or an accepted alternative matched. */
  lenient: boolean;
  /** Every non-label expectation (contested, stale, unresolved) held. */
  flagsHeld: boolean;
  /** Labelled not-supported, audited supported: the failure the audit exists to prevent. */
  falseSupport: boolean;
}

export interface CaseResult {
  caseId: string;
  readStates: Array<SourceReadState | null>;
  claims: ClaimResult[];
  /** Extracted claims no expectation names: the labelling is incomplete. */
  unlabelled: string[];
  /** Expectations that matched no extracted claim, or more than one. */
  unmatched: string[];
  /** Integrity of the repaired report — the "never invent a citation" checks. */
  integrity: {
    /** `[n]` markers in the repaired report that were not in the original. */
    addedMarkers: number[];
    /** `[n]` markers above the corpus size still in the repaired report. */
    unresolvedRemaining: number[];
    /** Links recorded to a source the claim did not cite. */
    linksToUncitedSources: number;
  };
  judgeCalls: number;
  repairedReport: string;
}

export interface Scorecard {
  judge: string;
  cases: number;
  claims: number;
  labelled: number;
  /** Of the claims the audit marked supported, the share a human also labelled supported. */
  supportedPrecision: number;
  /** Of the claims a human labelled supported, the share the audit marked supported. */
  supportedRecall: number;
  strictAccuracy: number;
  lenientAccuracy: number;
  /** Of the claims a human labelled contradicted, the share the audit called contradicted. */
  contradictionRecall: number;
  /** Of the claims the audit called contradicted, the share a human labelled contradicted (or accepts it). */
  contradictionPrecision: number;
  falseSupports: ClaimResult[];
  flagFailures: ClaimResult[];
  integrityFailures: string[];
  unlabelled: string[];
  unmatched: string[];
  results: CaseResult[];
}

function markersIn(text: string): number[] {
  return [...text.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1]));
}

/** Run one case through the production audit with the given judge. */
export async function runEvalCase(evalCase: EvalCase, judge: CitationJudge): Promise<CaseResult> {
  // The ledger a run would have written: a `source_read` for every page a
  // fetching stage opened, plus the READ stage's bookkeeping line for every
  // source in the wave, which is NOT a fetch and must not count as one.
  const events = [
    ...evalCase.sources.filter((s) => s.obtained === "opened").map((s) => ({ kind: "source_read", payload: { url: s.url, title: s.title } })),
    ...evalCase.sources.map((s) => ({ kind: "source_read", payload: { url: s.url, title: s.title, ranked: true } })),
  ];
  const opened = openedUrlsFrom({ events });
  const readStates = evalCase.sources.map((s) => sourceReadState({ url: s.url, textChars: s.body.trim().length }, opened));
  const sources = evalCase.sources.map((s, i) => ({
    index: i + 1,
    title: s.title,
    url: s.url,
    publishedAt: s.publishedAt ? new Date(`${s.publishedAt}T00:00:00Z`) : null,
    passages: splitPassages(s.body, { maxPassages: PASSAGES_PER_SOURCE }),
    truncated: isPreviewOnly(readStates[i]),
  }));
  const asOf = new Date(`${evalCase.asOf}T12:00:00Z`);
  const outcome = await auditClaims({
    claims: selectClaimsForAudit(evalCase.report, 200),
    sources,
    judge,
    judgeCap: 1_000,
    corpusSize: sources.length,
    asOf,
  });
  const repaired = repairReportFromClaims(
    evalCase.report,
    outcome.claims.map((claim) => ({ ...claim, unresolvedCitations: claim.unresolvedCitations, staleSince: claim.staleSince }))
  );

  const matchesFor = (expectation: EvalExpectation) => outcome.claims.filter((claim) => claim.text.includes(expectation.claim));
  const unmatched = evalCase.expectations.filter((e) => matchesFor(e).length !== 1).map((e) => `${evalCase.id}: "${e.claim}" matched ${matchesFor(e).length} claims`);
  const expectationOf = (claim: AuditedClaim) => {
    const hits = evalCase.expectations.filter((e) => claim.text.includes(e.claim) && matchesFor(e).length === 1);
    return hits.length === 1 ? hits[0]! : null;
  };

  const claims: ClaimResult[] = outcome.claims.map((claim) => {
    const expected = expectationOf(claim);
    const reasons = [...new Set(claim.links.flatMap((link) => link.reasons.map((r) => r.code)))];
    const stale = claim.links.some((link) => link.reasons.some((r) => r.code === "source_stale"));
    const actual = {
      label: claim.label,
      supportStrength: claim.supportStrength,
      contested: claim.contested,
      stale,
      unresolved: claim.unresolvedCitations,
      previewOnly: claim.previewOnly,
      reasons,
    };
    const accepted = expected ? [expected.label, ...(expected.accept ?? [])] : [];
    // "Contested" is a property of a SUPPORTED claim (other evidence disagrees
    // with a claim its citation supports), so it is only scored where the
    // human label is supported; on a claim a human calls contradicted, the
    // audit flagging disagreement is the right instinct, not a flag failure.
    const flagsHeld = expected
      ? (expected.label !== "supported" || actual.contested === (expected.contested ?? false)) &&
        actual.stale === (expected.stale ?? false) &&
        JSON.stringify([...actual.unresolved].sort()) === JSON.stringify([...(expected.unresolved ?? [])].sort())
      : false;
    return {
      caseId: evalCase.id,
      claim: claim.text,
      expected,
      actual,
      strict: !!expected && actual.label === expected.label,
      lenient: !!expected && accepted.includes(actual.label),
      flagsHeld,
      falseSupport: !!expected && expected.label !== "supported" && actual.label === "supported",
    };
  });

  const original = new Set(markersIn(evalCase.report));
  const repairedMarkers = markersIn(repaired.report);
  return {
    caseId: evalCase.id,
    readStates,
    claims,
    unlabelled: claims.filter((c) => !c.expected).map((c) => `${evalCase.id}: "${c.claim}"`),
    unmatched,
    integrity: {
      addedMarkers: [...new Set(repairedMarkers.filter((n) => !original.has(n)))],
      unresolvedRemaining: [...new Set(repairedMarkers.filter((n) => n < 1 || n > sources.length))],
      linksToUncitedSources: outcome.claims.reduce(
        (n, claim) => n + claim.links.filter((link) => !claim.citations.includes(link.sourceIndex)).length,
        0
      ),
    },
    judgeCalls: outcome.judgeCalls,
    repairedReport: repaired.report,
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

/** Run every case with one judge and score the lot. */
export async function scoreResearchCitationEval(
  cases: readonly EvalCase[],
  judge: CitationJudge,
  judgeName: string
): Promise<Scorecard> {
  const results: CaseResult[] = [];
  for (const evalCase of cases) results.push(await runEvalCase(evalCase, judge));
  const all = results.flatMap((r) => r.claims);
  const labelled = all.filter((c) => c.expected);
  const predictedSupported = labelled.filter((c) => c.actual.label === "supported");
  const trulySupported = labelled.filter((c) => c.expected!.label === "supported");
  const trulyContradicted = labelled.filter((c) => c.expected!.label === "contradicted");
  const predictedContradicted = labelled.filter((c) => c.actual.label === "contradicted");
  const integrityFailures = results.flatMap((r) => [
    ...(r.integrity.addedMarkers.length ? [`${r.caseId}: the repair added citation markers ${r.integrity.addedMarkers.join(", ")}`] : []),
    ...(r.integrity.unresolvedRemaining.length
      ? [`${r.caseId}: markers naming no source survived the repair: ${r.integrity.unresolvedRemaining.join(", ")}`]
      : []),
    ...(r.integrity.linksToUncitedSources ? [`${r.caseId}: ${r.integrity.linksToUncitedSources} links to sources the claim did not cite`] : []),
  ]);
  return {
    judge: judgeName,
    cases: cases.length,
    claims: all.length,
    labelled: labelled.length,
    supportedPrecision: ratio(predictedSupported.filter((c) => c.expected!.label === "supported").length, predictedSupported.length),
    supportedRecall: ratio(trulySupported.filter((c) => c.actual.label === "supported").length, trulySupported.length),
    strictAccuracy: ratio(labelled.filter((c) => c.strict).length, labelled.length),
    lenientAccuracy: ratio(labelled.filter((c) => c.lenient).length, labelled.length),
    contradictionRecall: ratio(trulyContradicted.filter((c) => c.actual.label === "contradicted").length, trulyContradicted.length),
    contradictionPrecision: ratio(
      predictedContradicted.filter((c) => [c.expected!.label, ...(c.expected!.accept ?? [])].includes("contradicted")).length,
      predictedContradicted.length
    ),
    falseSupports: labelled.filter((c) => c.falseSupport),
    flagFailures: labelled.filter((c) => !c.flagsHeld),
    integrityFailures,
    unlabelled: results.flatMap((r) => r.unlabelled),
    unmatched: results.flatMap((r) => r.unmatched),
    results,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** A plain-text scorecard: the headline numbers, then every miss with the reason a human gave. */
export function renderScorecard(card: Scorecard): string {
  const lines = [
    `Research citation eval — judge: ${card.judge}`,
    `  ${card.cases} reports, ${card.claims} claims extracted, ${card.labelled} labelled`,
    `  supported precision ${pct(card.supportedPrecision)} · supported recall ${pct(card.supportedRecall)}`,
    `  label accuracy ${pct(card.strictAccuracy)} strict / ${pct(card.lenientAccuracy)} lenient`,
    `  contradiction recall ${pct(card.contradictionRecall)} · contradiction precision ${pct(card.contradictionPrecision)}`,
    `  false supports ${card.falseSupports.length} · flag failures ${card.flagFailures.length} · integrity failures ${card.integrityFailures.length}`,
    ...(card.judge === "unavailable"
      ? ["  (no model answered: a claim the text alone cannot settle is unverified by design, so label misses below are expected)"]
      : []),
  ];
  for (const miss of card.falseSupports) {
    lines.push(`  FALSE SUPPORT [${miss.caseId}] "${miss.claim}" — labelled ${miss.expected!.label}: ${miss.expected!.why}`);
  }
  for (const result of card.results) {
    for (const claim of result.claims) {
      if (!claim.expected || (claim.strict && claim.flagsHeld)) continue;
      const flags = [
        claim.expected.label === "supported" && claim.actual.contested !== (claim.expected.contested ?? false)
          ? `contested=${claim.actual.contested}`
          : "",
        claim.actual.stale !== (claim.expected.stale ?? false) ? `stale=${claim.actual.stale}` : "",
        JSON.stringify(claim.actual.unresolved) !== JSON.stringify(claim.expected.unresolved ?? []) ? `unresolved=${claim.actual.unresolved.join(",")}` : "",
      ].filter(Boolean);
      lines.push(
        `  ${claim.lenient ? "lenient" : "MISS"} [${claim.caseId}] "${claim.claim.slice(0, 90)}" — expected ${claim.expected.label}, got ${
          claim.actual.label
        }${flags.length ? ` (${flags.join("; ")})` : ""} [${claim.actual.reasons.join(", ") || "no findings"}]`
      );
    }
  }
  for (const failure of card.integrityFailures) lines.push(`  INTEGRITY ${failure}`);
  for (const claim of card.unlabelled) lines.push(`  UNLABELLED ${claim}`);
  for (const expectation of card.unmatched) lines.push(`  UNMATCHED ${expectation}`);
  return lines.join("\n");
}

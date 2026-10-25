import test from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORTED_MIN,
  STALE_FOR_PRESENT_DAYS,
  auditEvidence,
  bestMatchingClause,
  extractClaims,
  namedSubjects,
  repairReportFromClaims,
  type CitationJudge,
} from "@/lib/research/claim-analysis";
import {
  MAX_RIVALS_PER_CLAIM,
  auditClaims,
  readAuditReceipt,
  selectClaimsForAudit,
  type AuditSource,
} from "@/lib/research/citation-audit-core";
import { serverOnlyIn } from "./fixtures/server-only-graph";

/*
 * The freshness, contradiction, disagreement and invented-citation checks of
 * the citation audit (master brief 7.1), one behaviour per test. The judge is
 * stubbed credulous wherever a verdict needs one, so a pass means the
 * deterministic audit did the work.
 */

const credulous: CitationJudge = async () => ({ verdict: "supported", strength: 0.95 });
const ASOF = new Date("2026-10-25T12:00:00Z");

function source(index: number, body: string, extra: Partial<AuditSource> = {}): AuditSource {
  return {
    index,
    title: `Source ${index}`,
    url: `https://s${index}.example/page`,
    publishedAt: null,
    truncated: false,
    passages: body
      .split(/\n{2,}/)
      .map((text, ordinal) => ({ text, locator: `chars:${ordinal * 1000}-${ordinal * 1000 + text.length}`, ordinal })),
    ...extra,
  };
}

async function audit(report: string, sources: AuditSource[], opts: { asOf?: Date | null; judge?: CitationJudge; rivalScan?: boolean } = {}) {
  return auditClaims({
    claims: selectClaimsForAudit(report, 40),
    sources,
    judge: opts.judge ?? credulous,
    judgeCap: 100,
    asOf: opts.asOf === undefined ? ASOF : opts.asOf,
    rivalScan: opts.rivalScan,
  });
}

test("pure: no server-only module in the core's graph", () => {
  assert.deepEqual(serverOnlyIn("src/lib/research/citation-audit-core.ts"), []);
});

// ── Freshness ───────────────────────────────────────────────────────────────

test("a present-tense claim on a source older than a year is held to partly supported", () => {
  const result = auditEvidence({
    claim: "The service currently costs $20 a month.",
    passage: "The service costs $20 a month for individuals, the company said.",
    publishedAt: new Date("2022-03-01T00:00:00Z"),
    asOf: ASOF,
  });
  const stale = result.reasons.find((r) => r.code === "source_stale");
  assert.ok(stale, "source_stale expected");
  assert.ok(stale.ceiling < SUPPORTED_MIN && stale.ceiling >= 0.4, "partly supported, never unsupported");
  assert.match(stale.detail, /2022-03-01/);
});

test("freshness does not fire when the check does not apply", () => {
  const old = new Date("2022-03-01T00:00:00Z");
  const passage = "The service costs $20 a month for individuals, the company said.";
  const cases: Array<[string, Parameters<typeof auditEvidence>[0]]> = [
    ["no asOf (an audit recorded before the check existed)", { claim: "The service currently costs $20 a month.", passage, publishedAt: old }],
    ["an undated page is the live page", { claim: "The service currently costs $20 a month.", passage, publishedAt: null, asOf: ASOF }],
    ["no present-tense marker", { claim: "The service costs $20 a month.", passage, publishedAt: old, asOf: ASOF }],
    ["the claim names its own date", { claim: "The service currently costs $20 a month as of March 2022.", passage: `${passage} Prices as of March 2022.`, publishedAt: old, asOf: ASOF }],
    ["a recent source", { claim: "The service currently costs $20 a month.", passage, publishedAt: new Date(ASOF.getTime() - (STALE_FOR_PRESENT_DAYS - 10) * 86_400_000), asOf: ASOF }],
    ["the page says it was updated recently", { claim: "The service currently costs $20 a month.", passage: `As of September 2026, the service costs $20 a month.`, publishedAt: old, asOf: ASOF }],
    ["a forecast", { claim: "The service will still cost $20 a month by 2027.", passage: "The service will cost $20 a month by 2027, the company expects.", publishedAt: old, asOf: ASOF }],
  ];
  for (const [why, input] of cases) {
    assert.ok(!auditEvidence(input).reasons.some((r) => r.code === "source_stale"), why);
  }
});

test("words that only look like present-state markers do not trigger freshness", () => {
  const old = new Date("2022-03-01T00:00:00Z");
  for (const claim of [
    "The country's current account deficit widened to 4% of GDP.",
    "Archaeologists found human remains near the site of the old mill.",
    "The studio sells still images and stock video to publishers.",
    "The museum had been closed until now for structural repairs.",
    "The remains of the original factory were listed in 1998.",
  ]) {
    const result = auditEvidence({ claim, passage: claim, publishedAt: old, asOf: ASOF });
    assert.ok(!result.reasons.some((r) => r.code === "source_stale"), claim);
  }
  for (const claim of [
    "The service is still free for students.",
    "The plan now costs $25 a month.",
    "The company remains the largest employer in the region.",
    "The service currently costs $20 a month.",
    "Shares have risen 6% this year.",
  ]) {
    const result = auditEvidence({ claim, passage: claim, publishedAt: old, asOf: ASOF });
    assert.ok(result.reasons.some((r) => r.code === "source_stale"), claim);
  }
});

test("a target year in the passage is not evidence the page is recent", () => {
  const result = auditEvidence({
    claim: "The country currently has 13.8 GW of capacity installed.",
    passage: "The country currently has 13.8 GW of capacity installed. The target is 50 GW by 2030.",
    publishedAt: new Date("2023-02-10T00:00:00Z"),
    asOf: ASOF,
  });
  assert.ok(result.reasons.some((r) => r.code === "source_stale"));
});

test("a stale claim is repaired as possibly out of date, not as partly supported", async () => {
  const report = "# R\n\nThe service currently costs $20 a month for individuals [1].";
  const outcome = await audit(report, [
    source(1, "The service costs $20 a month for individuals, the company said in its launch announcement.", {
      publishedAt: new Date("2022-03-01T00:00:00Z"),
    }),
  ]);
  const [claim] = outcome.claims;
  assert.equal(claim.label, "partially supported");
  assert.equal(claim.staleSince, "2022-03-01");
  const repaired = repairReportFromClaims(report, outcome.claims);
  assert.match(repaired.report, /Possibly out of date: The service currently costs \$20/);
  assert.match(repaired.report, /dates from 2022-03-01/);
});

// ── Contradictions inside the claim's own citations ─────────────────────────

test("a cited source that disagrees is recorded even after another one supports the claim", async () => {
  const outcome = await audit("# R\n\nThe city's population was 812,000 in mid-2025 [1][2].", [
    source(1, "The statistics office's mid-2025 figures put the city's population at 812,000, up 1.1% on the year."),
    source(2, "The city's population stood at 790,000 in mid-2025, the paper's own analysis found."),
  ]);
  const [claim] = outcome.claims;
  assert.equal(claim.status, "supported");
  assert.equal(claim.contested, true);
  const against = claim.links.find((l) => l.stance === "contradicts");
  assert.ok(against);
  assert.equal(against.sourceIndex, 2);
  assert.equal(against.judged, false, "a text-settled contradiction spends no judge call");
  assert.equal(outcome.counts.contested, 1);
});

test("two cited sources that agree are not contested", async () => {
  const outcome = await audit("# R\n\nThe city's population was 812,000 in mid-2025 [1][2].", [
    source(1, "The statistics office's mid-2025 figures put the city's population at 812,000, up 1.1% on the year."),
    source(2, "The city's population stood at 812,000 in mid-2025, according to the census bureau's release."),
  ]);
  assert.equal(outcome.claims[0].contested, false);
  assert.equal(outcome.counts.contested, 0);
});

test("an annual report's previous-year and segment paragraphs do not contest its own headline figure", async () => {
  const report = "# R\n\nNorthwind's revenue was $4.3 billion in 2024 [1].";
  for (const other of [
    "Northwind's revenue was $3.9 billion in 2023, the previous annual report said.",
    "Northwind's logistics revenue was $1.8 billion in 2024, the segment note shows.",
    "Revenue in the logistics division was $1.8 billion in 2024, and the industrial division made the rest.",
  ]) {
    const outcome = await audit(report, [source(1, `Northwind's revenue was $4.3 billion in 2024, the annual report says.\n\n${other}`)]);
    const [claim] = outcome.claims;
    assert.equal(claim.status, "supported", other);
    assert.equal(claim.contested, false, `${other}: ${JSON.stringify(claim.links)}`);
    assert.ok(claim.links.every((l) => l.stance === "supports"), other);
  }
});

test("the same source restating the same figure for the same year still contests it", async () => {
  const outcome = await audit("# R\n\nNorthwind's revenue was $4.3 billion in 2024 [1].", [
    source(1, "Northwind's revenue was $4.3 billion in 2024, the annual report says.\n\nNorthwind's revenue was $4.1 billion in 2024 after the restatement, the auditors found."),
  ]);
  assert.equal(outcome.claims[0].contested, true);
});

test("a segment or a previous year in an UNCITED source is not a rival either", async () => {
  const report = "# R\n\nNorthwind's revenue was $4.3 billion in 2024 [1].";
  const cited = source(1, "Northwind's revenue was $4.3 billion in 2024, the annual report says.");
  for (const body of [
    "Northwind's logistics revenue was $1.8 billion in 2024, analysts estimate.",
    "Northwind's revenue was $3.9 billion in 2023, analysts noted.",
  ]) {
    const outcome = await audit(report, [cited, source(2, body)]);
    assert.deepEqual(outcome.claims[0].rivals, [], body);
    assert.equal(outcome.claims[0].contested, false, body);
  }
});

test("a figure for a narrower subject is not a contradiction; the same subject with a scope word is", () => {
  const segment = auditEvidence({
    claim: "Northwind's revenue was $4.3 billion in 2024.",
    passage: "Northwind's logistics revenue was $1.8 billion in 2024.",
  });
  assert.equal(segment.contradicted, false);
  assert.ok(segment.reasons.some((r) => r.code === "figure_absent"));
  const narrowerClaim = auditEvidence({
    claim: "Northwind's logistics revenue was $1.8 billion in 2024.",
    passage: "Northwind's revenue was $4.3 billion in 2024.",
  });
  assert.equal(narrowerClaim.contradicted, false);
  for (const passage of [
    "Total revenue was $3.9 billion in 2024.",
    "The company's revenue was $3.9 billion in 2024.",
    "Revenue for the year was $3.9 billion in 2024.",
  ]) {
    assert.equal(auditEvidence({ claim: "Northwind's revenue was $4.3 billion in 2024.", passage }).contradicted, true, passage);
  }
});

// ── Rival figures in sources the claim did not cite ─────────────────────────

test("an uncited source giving a different figure for the same thing and date is surfaced, without changing the verdict", async () => {
  const outcome = await audit("# R\n\nInstalled capacity reached 16.5 GW at the end of June 2026 [1].", [
    source(1, "Installed capacity reached 16.5 GW at the end of June 2026, the department's statistics show."),
    source(2, "On a stricter basis installed capacity stood at 15.1 GW at the end of June 2026, the review found."),
  ]);
  const [claim] = outcome.claims;
  assert.equal(claim.status, "supported", "an uncited source never decides the verdict");
  assert.equal(claim.rivals.length, 1);
  assert.equal(claim.rivals[0].sourceIndex, 2);
  assert.ok(claim.rivals[0].reasons.every((r) => r.code === "figure_mismatch"));
  assert.equal(claim.contested, true);
  assert.ok(claim.links.every((l) => claim.citations.includes(l.sourceIndex)), "a rival is never a link");
});

test("a different year is not a rival, and the scan can be switched off", async () => {
  const report = "# R\n\nAt the 2001 census the city's population was 650,000 [1].";
  const sources = [
    source(1, "At the 2001 census the city's population was 650,000, of whom 21% were under 16."),
    source(2, "The city's population was 812,000 in mid-2025, the statistics office estimates show."),
  ];
  assert.deepEqual((await audit(report, sources)).claims[0].rivals, []);
  const rivalSources = [
    source(1, "Installed capacity reached 16.5 GW at the end of June 2026, the department's statistics show."),
    source(2, "Installed capacity stood at 15.1 GW at the end of June 2026, the review found."),
  ];
  const off = await audit("# R\n\nInstalled capacity reached 16.5 GW at the end of June 2026 [1].", rivalSources, { rivalScan: false });
  assert.deepEqual(off.claims[0].rivals, []);
});

test("rivals are bounded per claim, one per source", async () => {
  const others = [2, 3, 4, 5].map((i) => source(i, `Installed capacity stood at 1${i}.0 GW at the end of June 2026, report ${i} found.`));
  const outcome = await audit("# R\n\nInstalled capacity reached 16.5 GW at the end of June 2026 [1].", [
    source(1, "Installed capacity reached 16.5 GW at the end of June 2026, the department's statistics show."),
    ...others,
  ]);
  const rivals = outcome.claims[0].rivals;
  assert.ok(rivals.length <= MAX_RIVALS_PER_CLAIM);
  assert.equal(new Set(rivals.map((r) => r.sourceIndex)).size, rivals.length);
});

// ── Invented citations ──────────────────────────────────────────────────────

test("a citation past the end of the corpus is reported and removed, never left in the answer", async () => {
  const report = "# R\n\nAll plans include unlimited projects and 30-day version history [1][5]. The company was founded in Lisbon in 2019 [7].";
  const outcome = await audit(report, [source(1, "All plans include unlimited projects and 30-day version history, and the Business plan adds single sign-on.")]);
  const [plans, founded] = outcome.claims;
  assert.deepEqual(plans.unresolvedCitations, [5]);
  assert.equal(plans.status, "supported");
  assert.deepEqual(founded.unresolvedCitations, [7]);
  assert.equal(founded.status, "unsupported");
  assert.equal(outcome.counts.unresolvedCitations, 2);

  const repaired = repairReportFromClaims(report, outcome.claims);
  assert.doesNotMatch(repaired.report, /\[5\]|\[7\]/);
  assert.match(repaired.report, /30-day version history \[1\]\./, "the real citation stays, the invented one goes");
  assert.match(repaired.report, /Unsourced: The company was founded in Lisbon in 2019\./);
  // Nothing is ever added.
  const before = new Set([...report.matchAll(/\[(\d+)\]/g)].map((m) => m[1]));
  for (const m of repaired.report.matchAll(/\[(\d+)\]/g)) assert.ok(before.has(m[1]!));
});

test("a table cell's invented citation is removed in place, keeping the table's shape", () => {
  const report = "| Product | Price |\n|---|---|\n| Alpha | $20 per month [1][9] |";
  const claims = extractClaims(report).map((claim) => ({
    ...claim,
    status: "supported" as const,
    supportStrength: 0.9,
    unresolvedCitations: claim.citations.filter((n) => n > 1),
  }));
  const repaired = repairReportFromClaims(report, claims);
  assert.equal(repaired.report, "| Product | Price |\n|---|---|\n| Alpha | $20 per month [1] |");
});

// ── Previews ────────────────────────────────────────────────────────────────

test("an unsupported verdict reached only against a search preview is unverified; against a page it stands", async () => {
  const report = "# R\n\nReviewers rated the mobile app 4.8 out of 5 [1].";
  const body = "A capable tool for small teams. We tested the plan for a month and found the editor fast and the mobile app solid.";
  const previewed = await audit(report, [source(1, body, { truncated: true })]);
  assert.equal(previewed.claims[0].status, "unverified");
  assert.equal(previewed.claims[0].previewOnly, true);
  const read = await audit(report, [source(1, body, { truncated: false })]);
  assert.equal(read.claims[0].status, "unsupported");
  assert.equal(read.claims[0].previewOnly, false);
});

// ── False contradictions the whole-report eval found ─────────────────────────

test("a comparison citing one source per subject is not read as each source contradicting the other", async () => {
  const outcome = await audit("# R\n\nAlpha Pro includes twice the storage of Beta Plus, at 100 GB against 50 GB [1][2].", [
    source(1, "Alpha Pro costs $20 per month and includes 100 GB of storage. Alpha Free includes 5 GB of storage."),
    source(2, "Beta Plus costs $15 per month and includes 50 GB of storage. Beta Basic includes 2 GB of storage."),
  ]);
  const [claim] = outcome.claims;
  assert.equal(claim.status, "supported");
  assert.equal(claim.contested, false);
  assert.ok(claim.links.some((l) => l.reasons.some((r) => r.code === "stated_by_other_citation" && r.ceiling === 1)));
});

test("corroboration never masks two sources disagreeing about the same subject, nor a misattributed figure", async () => {
  // Same subject, different figures: still a disagreement.
  const same = await audit("# R\n\nSpringfield's population was 812,000 in mid-2025 [1][2].", [
    source(1, "Springfield's population was 812,000 in mid-2025, the statistics office said."),
    source(2, "Springfield's population stood at 790,000 in mid-2025, the paper's analysis found."),
  ]);
  assert.equal(same.claims[0].contested, true);
  // Alpha's figure taken from Beta's page: Alpha's own page still contradicts it.
  const misattributed = auditEvidence({
    claim: "Alpha Pro costs $15 per month.",
    passage: "Alpha Pro costs $20 per month and includes 100 GB of storage.",
    corroborating: ["Beta Plus costs $15 per month and includes 50 GB of storage."],
  });
  assert.equal(misattributed.contradicted, true);
});

test("named subjects skip the first word of every sentence, sentence starters and units", () => {
  // "Alpha" opens a sentence, so it is skipped like "Revenue" would be: any
  // word is title case there. Mid-sentence names are kept.
  assert.deepEqual([...namedSubjects("Alpha Pro includes 100 GB. The plan from Beta Plus is cheaper.")].sort(), ["beta", "plus", "pro"]);
  assert.deepEqual([...namedSubjects("Revenue rose to $4.3 billion in 2024.")], []);
  assert.deepEqual([...namedSubjects("Revenue rose. Alpha Pro is cheaper.", { withSentenceStarts: true })].sort(), ["alpha", "pro", "revenue"]);
});

test("corroboration never hides a cited passage that gives a different figure: a sentence-opening common noun", async () => {
  // "Revenue" opens the claim; it used to count as a named subject that [1]
  // (which says "revenue") lacks, so [2]'s $4.3bn stood in for [1] and the
  // $3.9bn passage was recorded as SUPPORT.
  const report = "# R\n\nRevenue rose to $4.3 billion in 2024 [1][2].";
  const one = source(1, "The company said revenue rose to $3.9 billion in 2024, below its own guidance.");
  const undated = await audit(report, [one, source(2, "Revenue reached $4.3 billion, the chief executive told investors.")]);
  const [claim] = undated.claims;
  assert.notEqual(claim.status, "supported");
  assert.ok(claim.links.some((l) => l.sourceIndex === 1 && l.stance === "contradicts"));
  assert.ok(!claim.links.some((l) => l.sourceIndex === 1 && l.stance === "supports"), "the $3.9bn passage is never support");

  const dated = await audit(report, [one, source(2, "Revenue reached $4.3 billion in 2024, the chief executive told investors.")]);
  assert.equal(dated.claims[0].status, "supported");
  assert.equal(dated.claims[0].contested, true, "two cited sources disagree, and the reader is told");
  assert.ok(dated.claims[0].links.some((l) => l.sourceIndex === 1 && l.stance === "contradicts"));
});

test("corroboration never hides a cited passage that gives a different figure: a subject one passage leaves unnamed", async () => {
  // [1] says "the company" where the claim says "Northwind": the name is
  // missing from [1], [2] has it, and [2]'s figure used to mask [1]'s.
  const outcome = await audit("# R\n\nIn 2024, Northwind's revenue rose to $4.3 billion [1][2].", [
    source(1, "The company's revenue rose to $3.9 billion in 2024, its annual report shows."),
    source(2, "Northwind's revenue rose to $4.3 billion in 2024, the wire reported."),
  ]);
  const [claim] = outcome.claims;
  assert.equal(claim.status, "supported");
  assert.equal(claim.contested, true);
  const fromOne = claim.links.filter((l) => l.sourceIndex === 1);
  assert.ok(fromOne.length > 0 && fromOne.every((l) => l.stance === "contradicts"), JSON.stringify(claim.links));
  assert.ok(!fromOne.some((l) => l.reasons.some((r) => r.code === "stated_by_other_citation")));
});

test("two counts of days measuring different things are not a contradiction; the same thing is", () => {
  const differentThings = auditEvidence({
    claim: "All plans include 30-day version history.",
    passage: "Every plan comes with a 14-day free trial. All plans include unlimited projects.",
  });
  assert.equal(differentThings.contradicted, false);
  const sameThing = auditEvidence({
    claim: "Every plan comes with a 90-day free trial.",
    passage: "Every plan comes with a 14-day free trial and can be cancelled at any time.",
  });
  assert.equal(sameThing.contradicted, true);
});

test("figures in two-letter units are compared as the same quantity", () => {
  const result = auditEvidence({
    claim: "UK offshore wind capacity was 16.5 GW at the end of June 2026.",
    passage: "UK offshore wind capacity stood at 15.1 GW at the end of June 2026.",
  });
  assert.ok(result.reasons.some((r) => r.code === "figure_mismatch"));
});

test("a claim identical to its source is never contradicted by a negation in a leading or trailing clause", () => {
  for (const sentence of [
    "Sales rose sharply in 2024, but profits did not.",
    "The vaccine reduced hospitalisations, although it did not prevent infection.",
    "The regulator approved the merger, which the companies had not expected.",
    "The drug did not reduce mortality, but it shortened hospital stays by two days",
    "Profits did not rise in 2024, while sales grew by 8%.",
  ]) {
    const result = auditEvidence({ claim: sentence, passage: sentence });
    assert.equal(result.contradicted, false, sentence);
    assert.equal(result.ceiling, 1, `${sentence}: ${result.reasons.map((r) => r.code).join(", ")}`);
    assert.deepEqual(result.reasons, [], sentence);
  }
});

test("a claim identical to its source passes the whole audit and the repair untouched", async () => {
  const report = "# R\n\nNorthwind's sales rose sharply in 2024, but its profits did not [1].";
  const outcome = await audit(report, [source(1, "Northwind's sales rose sharply in 2024, but its profits did not.")]);
  const [claim] = outcome.claims;
  assert.equal(claim.status, "supported");
  assert.equal(outcome.judgeCalls, 1, "the judge is asked, not pre-empted by a false contradiction");
  assert.equal(repairReportFromClaims(report, outcome.claims).report, report);
});

test("clause against clause still catches a clause the passage negates", () => {
  // Trailing clause flipped either way.
  assert.equal(
    auditEvidence({
      claim: "Northwind's sales rose sharply in 2024, but its profits did not.",
      passage: "Northwind's sales rose sharply in 2024, and its profits rose too.",
    }).contradicted,
    true
  );
  assert.equal(
    auditEvidence({
      claim: "Northwind's sales rose sharply in 2024, and its profits rose too.",
      passage: "Northwind's sales rose sharply in 2024, but its profits did not.",
    }).contradicted,
    true
  );
  // Leading clause flipped, the trailing one agreeing.
  assert.equal(
    auditEvidence({
      claim: "The drug reduced mortality, and it shortened hospital stays by two days.",
      passage: "The drug did not reduce mortality, but it shortened hospital stays by two days.",
    }).contradicted,
    true
  );
});

test("a one-clause claim is denied by an elided negation in another clause, and only by one about it", () => {
  // The "not" that answers "profits rose" sits in a clause with no verb; the
  // clause sharing the most words is about sales.
  for (const claim of ["Profits rose in 2024.", "Northwind's profits rose in 2024."]) {
    const result = auditEvidence({ claim, passage: "Northwind's sales rose sharply in 2024, but its profits did not." });
    assert.equal(result.contradicted, true, claim);
  }
  for (const passage of [
    "Revenue rose in 2024, but costs did not.",
    "Revenue rose in 2024, but revenue did not rise in Europe.",
  ]) {
    assert.equal(auditEvidence({ claim: "Revenue rose in 2024.", passage }).contradicted, false, passage);
  }
});

test("a negation in another clause does not flip the sentence; a negation of the claim itself does", () => {
  const trailing = auditEvidence({
    claim: "Serious adverse events occurred in 3% of the treatment group.",
    passage:
      "Serious adverse events occurred in 3% of the treatment group and 2% of the placebo group, a difference the authors described as not significant.",
  });
  assert.equal(trailing.contradicted, false);
  const denied = auditEvidence({
    claim: "The agency approved the drug for the treatment of relapse.",
    passage: "The agency has not approved the drug for the treatment of relapse.",
  });
  assert.equal(denied.contradicted, true);
  assert.equal(
    bestMatchingClause("serious adverse events 3%", "Serious adverse events occurred in 3%, which was not significant"),
    "Serious adverse events occurred in 3%"
  );
});

// ── The audit receipt ───────────────────────────────────────────────────────

test("the audit receipt reads what newer audits record and tolerates what older ones lack", () => {
  const empty = readAuditReceipt({ sourceOrder: ["a"] });
  assert.equal(empty.readStates, null, "absent is unknown, not 'all opened'");
  assert.equal(empty.asOf, null);
  assert.equal(empty.claimCitations, null);
  assert.deepEqual(empty.rivals, []);

  const full = readAuditReceipt({
    readStates: { a: "opened", b: "search_preview", c: "bogus" },
    asOf: "2026-10-25T12:00:00.000Z",
    claimCitations: { c1: { sourceIds: ["a", 3], unresolved: [7, "x"] } },
    rivals: [{ claimId: "c1", sourceId: "b", passageId: "p1" }, { claimId: "c1" }, "nonsense"],
  });
  assert.deepEqual([...full.readStates!.entries()], [["a", "opened"], ["b", "search_preview"]]);
  assert.equal(full.asOf?.toISOString(), "2026-10-25T12:00:00.000Z");
  assert.deepEqual(full.claimCitations?.get("c1"), { sourceIds: ["a"], unresolved: [7] });
  assert.deepEqual(full.rivals, [{ claimId: "c1", sourceId: "b", passageId: "p1" }]);
  assert.deepEqual(readAuditReceipt(null).rivals, []);
});

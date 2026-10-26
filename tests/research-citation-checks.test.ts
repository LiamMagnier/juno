import test from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORTED_MIN,
  STALE_FOR_PRESENT_DAYS,
  auditEvidence,
  bestMatchingClause,
  differsFromSupportingPassage,
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
    // "remains" as the noun, followed by a word the verb also takes.
    "Human remains at the site were dated to 3000 BC.",
    "The fossil remains in a private collection in Berlin.",
    "Skeletal remains on the riverbank were reburied in 1987.",
    // "current" that heads no role, price or version stated as a fact.
    "The current account deficit is 4% of GDP.",
    // "remains" before what only the noun takes, and "remain" after a modal.
    "Remains of a Roman villa were found near the river.",
    "Excavated remains suggest a large settlement by the river.",
    "Prices could remain high for years.",
  ]) {
    const result = auditEvidence({ claim, passage: claim, publishedAt: old, asOf: ASOF });
    assert.ok(!result.reasons.some((r) => r.code === "source_stale"), claim);
  }
  for (const claim of [
    "The service is still free for students.",
    "The plan now costs $25 a month.",
    "The company remains the largest employer in the region.",
    "The rules remain in force across the bloc.",
    "The service currently costs $20 a month.",
    "Shares have risen 6% this year.",
    // "current" heading a role, a price or a version that the sentence says IS something.
    "The current CEO is Jane Doe.",
    "Its current chief executive is Jane Doe.",
    "The current price is $20 a month.",
    "The current stable version is 3.2.",
    // …either way round; and "remain" as the verb, with any predicate.
    "Jane Doe is the current CEO of Northwind.",
    "Prices remain high across the region.",
    "It remains unprofitable.",
    "Inflation remains above the central bank's target.",
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

test("an undated figure is not contested by another year's figure when its support names its own year", async () => {
  const report = "# R\n\nNorthwind's revenue was $4.3 billion [1].";
  const supporting = "Northwind's revenue was $4.3 billion in 2024, the annual report says.";
  const lastYear = "Northwind's revenue was $3.9 billion in 2023, the previous annual report said.";
  // The same source's previous-year paragraph, and an uncited source's.
  for (const sources of [[source(1, `${supporting}\n\n${lastYear}`)], [source(1, supporting), source(2, lastYear)]]) {
    const [claim] = (await audit(report, sources)).claims;
    assert.equal(claim.status, "supported");
    assert.equal(claim.contested, false, JSON.stringify(claim.links));
    assert.ok(claim.links.every((l) => l.stance === "supports"));
    assert.deepEqual(claim.rivals, []);
  }
  // Still a disagreement: the same year, an undated rival, or an undated support.
  for (const body of [
    `${supporting}\n\nNorthwind's revenue was $4.1 billion in 2024 after the restatement, the auditors found.`,
    `${supporting}\n\nNorthwind's revenue was $4.1 billion after the restatement, the auditors found.`,
    `Northwind's revenue was $4.3 billion, the annual report says.\n\n${lastYear}`,
  ]) {
    const [claim] = (await audit(report, [source(1, body)])).claims;
    assert.equal(claim.status, "supported", body);
    assert.equal(claim.contested, true, body);
  }
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

test("a figure for a narrower subject is not a contradiction; the same owner's figure is; another wording of the owner is left to the judge", () => {
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
  // The claim's own owner, measure and year: settled by the text.
  const same = auditEvidence({ claim: "Northwind's revenue was $4.3 billion in 2024.", passage: "Northwind's revenue was $3.9 billion in 2024." });
  assert.equal(same.contradicted, true);
  assert.ok(same.reasons.some((r) => r.code === "figure_mismatch"));
  // No owner, or another word for it: it may be Northwind's revenue, and only a reader can say. A disagreement
  // the judge reads (and a supported claim shows as contested), never a contradiction with the judge skipped.
  for (const passage of [
    "Total revenue was $3.9 billion in 2024.",
    "The company's revenue was $3.9 billion in 2024.",
    "Revenue for the year was $3.9 billion in 2024.",
  ]) {
    const result = auditEvidence({ claim: "Northwind's revenue was $4.3 billion in 2024.", passage });
    assert.equal(result.contradicted, false, passage);
    assert.ok(result.reasons.some((r) => r.code === "figure_differs"), `${passage}: ${result.reasons.map((r) => r.code).join(", ")}`);
    assert.ok(result.ceiling < SUPPORTED_MIN, passage);
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
  // "On a stricter basis" may be another measure: a rival the text cannot settle (`figure_differs`) is still surfaced.
  assert.ok(claim.rivals[0].reasons.every((r) => r.code === "figure_mismatch" || r.code === "figure_differs"));
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

test("a comparison citing one source per subject is not read as each source contradicting the other, nor carried by the other", async () => {
  const outcome = await audit("# R\n\nAlpha Pro includes twice the storage of Beta Plus, at 100 GB against 50 GB [1][2].", [
    source(1, "Alpha Pro costs $20 per month and includes 100 GB of storage. Alpha Free includes 5 GB of storage."),
    source(2, "Beta Plus costs $15 per month and includes 50 GB of storage. Beta Basic includes 2 GB of storage."),
  ]);
  const [claim] = outcome.claims;
  // Each source gives its own subject's figure and never the other's: no disagreement, so nothing contradicts and
  // nothing is contested. And each passage is judged on its own text — another citation never supplies the figure a
  // passage lacks — so neither carries the whole sentence: it reads as not established, never as supported.
  assert.notEqual(claim.status, "contradicted");
  assert.equal(claim.contested, false);
  assert.ok(claim.links.length > 0 && claim.links.every((l) => l.stance === "supports" && l.status !== "supported"), JSON.stringify(claim.links));
  assert.ok(claim.links.every((l) => l.reasons.some((r) => r.code === "figure_absent")), JSON.stringify(claim.links));
});

test("two sources disagreeing about the same subject are shown, and a misattributed figure is contradicted", async () => {
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

test("another citation never hides a cited passage that gives a different figure: a sentence-opening common noun", async () => {
  // "Revenue" opens the claim. When another cited source could stand in for a
  // passage, it counted as a named subject that [1] (which says "revenue")
  // lacked, so [2]'s $4.3bn stood in for [1] and the $3.9bn passage was
  // recorded as SUPPORT.
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

test("another citation never hides a cited passage that gives a different figure: a subject one passage leaves unnamed", async () => {
  // [1] says "the company" where the claim says "Northwind": the name is
  // missing from [1], [2] has it, and [2]'s figure once masked [1]'s.
  const outcome = await audit("# R\n\nIn 2024, Northwind's revenue rose to $4.3 billion [1][2].", [
    source(1, "The company's revenue rose to $3.9 billion in 2024, its annual report shows."),
    source(2, "Northwind's revenue rose to $4.3 billion in 2024, the wire reported."),
  ]);
  const [claim] = outcome.claims;
  assert.equal(claim.status, "supported");
  assert.equal(claim.contested, true);
  const fromOne = claim.links.filter((l) => l.sourceIndex === 1);
  assert.ok(fromOne.length > 0 && fromOne.every((l) => l.stance === "contradicts"), JSON.stringify(claim.links));
});

test("another citation never hides a cited passage that gives a different figure: a verb read as the measured noun's qualifier", async () => {
  // "booked revenue of" read "booked" as a narrower revenue, so the $3.9bn
  // was no rival and [2]'s $4.3bn stood in for it: [1] was shown as support.
  for (const verb of ["booked", "achieved", "logged", "registered", "delivered", "announced", "disclosed", "secured", "expects", "forecast", "targets"]) {
    const passage = `The company ${verb} revenue of $3.9 billion in 2024, its annual filing shows.`;
    const result = auditEvidence({ claim: "In 2024, Northwind's revenue was $4.3 billion.", passage });
    assert.ok(result.ceiling < SUPPORTED_MIN, `${verb}: ${result.reasons.map((r) => r.code).join(", ")}`);
    assert.equal(result.contradicted, false, verb);
  }
  // A verb read as the measured noun itself.
  const head = auditEvidence({
    claim: "In 2024, Northwind's revenue was $4.3 billion.",
    passage: "The company tallied $3.9 billion in revenue in 2024.",
  });
  assert.ok(head.ceiling < SUPPORTED_MIN, head.reasons.map((r) => r.code).join(", "));

  // End to end: [1] is never the support, and the claim is not supported on it.
  const outcome = await audit("# R\n\nIn 2024, Northwind's revenue was $4.3 billion [1][2].", [
    source(1, "The company booked revenue of $3.9 billion in 2024, its annual filing shows."),
    source(2, "Northwind's revenue: $4.3 billion."),
  ]);
  const [claim] = outcome.claims;
  assert.notEqual(claim.status, "supported");
  assert.ok(!claim.links.some((l) => l.sourceIndex === 1 && l.status === "supported"), JSON.stringify(claim.links));
});

test("a page's figure for the claim's year is not the evidence for the claim's equal figure of another year", async () => {
  const claim = "Northwind's revenue was $4.3 billion in 2024, up from $3.9 billion in 2023.";
  // Alone: $3.9bn given for 2024 contradicts the claim's 2024 figure.
  const sameYear = auditEvidence({ claim, passage: "Northwind's revenue was $3.9 billion in 2024, the filing shows." });
  assert.equal(sameYear.contradicted, true);
  assert.ok(sameYear.reasons.some((r) => r.code === "figure_mismatch"));
  // Given for 2023, it is that figure's evidence: the 2024 figure is merely absent.
  const previousYear = auditEvidence({ claim, passage: "Northwind's revenue was $3.9 billion in 2023, the filing shows." });
  assert.equal(previousYear.contradicted, false);
  assert.ok(previousYear.reasons.some((r) => r.code === "figure_absent"));

  // Cited beside another source: [1] gives $3.9bn for 2024 ("the company's",
  // not Northwind's: a disagreement the judge reads, never one the text
  // settles) and is never shown as support, whether or not [2] carries the
  // claim on its own.
  const report = "# R\n\nIn 2024, Northwind's revenue was $4.3 billion, up from $3.9 billion in 2023 [1][2].";
  const one = source(1, "In 2024, the company's revenue was $3.9 billion, its annual filing shows, after $3.6 billion in 2023.");
  for (const two of ["Northwind: revenue $4.3 billion.", "Northwind's revenue was $4.3 billion in 2024, up from $3.9 billion in 2023."]) {
    const [audited] = (await audit(report, [one, source(2, two)])).claims;
    const fromOne = audited.links.filter((l) => l.sourceIndex === 1);
    assert.ok(fromOne.length > 0 && fromOne.every((l) => l.status !== "supported"), `${two}: ${JSON.stringify(audited.links)}`);
    assert.ok(fromOne.every((l) => l.reasons.some((r) => r.code === "figure_differs")), `${two}: ${JSON.stringify(audited.links)}`);
    assert.notEqual(audited.status, "contradicted", two);
    if (audited.status === "supported") assert.equal(audited.contested, true, two);
  }
  // An honest comparison across two sources, one subject each: neither disagrees, so nothing is contradicted or
  // contested — and neither carries the other's figure, so the sentence is not supported by either alone.
  const honest = await audit("# R\n\nNorthwind earned $4.3 billion in 2024, while Southwind earned $2.1 billion [1][2].", [
    source(1, "Northwind earned $4.3 billion in 2024, its report says."),
    source(2, "Southwind earned $2.1 billion in 2024, its report says."),
  ]);
  assert.notEqual(honest.claims[0].status, "contradicted");
  assert.notEqual(honest.claims[0].status, "supported");
  assert.equal(honest.claims[0].contested, false);
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
  // The "not" that answers "profits rose" sits in a clause with no verb, and
  // "its profits" are Northwind's: the elided clause denies the claim's own words.
  const passage = "Northwind's sales rose sharply in 2024, but its profits did not.";
  assert.equal(auditEvidence({ claim: "Northwind's profits rose in 2024.", passage }).contradicted, true);
  // Profits with no owner are not "its profits" in the same words: the judge reads it.
  assert.equal(auditEvidence({ claim: "Profits rose in 2024.", passage }).contradicted, false);
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

// The passage span the polarity check reads can be two sentences: a sentence
// ending in a figure ("…in 2024.") is not split from the next one.

test("a claim joining two source sentences, the first ending in a figure, is not contradicted, end to end through the repair", async () => {
  for (const [sentence, body] of [
    ["The EU adopted the AI Act in 2024, but the rules do not apply until 2026", "The EU adopted the AI Act in 2024. Most of its rules do not apply until 2026."],
    ["Emissions fell 3% in 2023, but they did not fall enough to meet the target", "Emissions fell 3% in 2023. They did not fall enough to meet the 2030 target, the agency said."],
    ["Northwind did not raise its dividend, although revenue grew 8% in 2024", "Northwind's revenue grew 8% in 2024. The company did not raise its dividend, citing capital needs."],
    ["Northwind's sales rose sharply in 2024, but its profits did not", "Northwind's sales rose sharply in 2024. Its profits did not."],
  ]) {
    const report = `# R\n\n${sentence} [1].`;
    const outcome = await audit(report, [source(1, body!)]);
    const [claim] = outcome.claims;
    assert.equal(claim.status, "supported", `${sentence}: ${JSON.stringify(claim.links)}`);
    assert.equal(outcome.judgeCalls, 1, `${sentence}: the judge is asked`);
    assert.ok(!claim.links.some((l) => l.reasons.some((r) => r.code === "polarity_mismatch")), sentence);
    assert.equal(repairReportFromClaims(report, outcome.claims).report, report, sentence);
  }
});

test("a verbatim claim is not contradicted by a neighbouring sentence that ends in a figure and holds a 'not'", async () => {
  for (const [claim, passage] of [
    ["Northwind's sales rose sharply in 2024, but its profits did not.", "Costs did not change in 2023. Northwind's sales rose sharply in 2024, but its profits did not."],
    ["Emissions fell 3% in 2023, and they fell again in 2024.", "Emissions fell 3% in 2023, and they fell again in 2024. They did not fall enough to meet the target."],
    ["The EU adopted the AI Act in 2024, but most rules do not apply until 2026.", "The EU adopted the AI Act in 2024, but most rules do not apply until 2026. Fines can reach 7%."],
  ]) {
    const result = auditEvidence({ claim: claim!, passage: passage! });
    assert.equal(result.contradicted, false, claim);
    assert.deepEqual(result.reasons, [], `${claim}: ${result.reasons.map((r) => r.code).join(", ")}`);
  }
  const report = "# R\n\nEmissions fell 3% in 2023, and they fell again in 2024 [1].";
  const outcome = await audit(report, [source(1, "Emissions fell 3% in 2023, and they fell again in 2024. They did not fall enough to meet the target.")]);
  assert.equal(outcome.claims[0].status, "supported");
  assert.equal(repairReportFromClaims(report, outcome.claims).report, report);
});

test("across a sentence end, a clause the passage negates is still caught", () => {
  // The second sentence denies the claim's second clause.
  assert.equal(
    auditEvidence({
      claim: "Revenue grew 8% in 2024, and the company raised its dividend.",
      passage: "Revenue grew 8% in 2024. The company did not raise its dividend.",
    }).contradicted,
    true
  );
  // An elided negation in the next sentence answers a one-clause claim.
  assert.equal(auditEvidence({ claim: "Northwind's profits rose in 2024.", passage: "Northwind's sales rose in 2024. Its profits did not." }).contradicted, true);
});

test("a hedge or alternative tail with no word of its own does not flip the clause; an elided negation does", async () => {
  for (const [claim, passage] of [
    ["Northwind's shares rose 5% on the day of the announcement.", "Northwind's shares rose 5% on the day of the announcement, if not more."],
    ["Unemployment fell to 4% in 2024.", "Unemployment fell to 4% in 2024, not 3%."],
    ["The plan was approved in 2024.", "The plan was approved in 2024, or not, depending on whom you ask."],
    ["Northwind's shares rose 5% on the day of the announcement, if not more.", "Northwind's shares rose 5% on the day of the announcement."],
  ]) {
    const result = auditEvidence({ claim: claim!, passage: passage! });
    assert.equal(result.contradicted, false, `${claim} <> ${passage}: ${result.reasons.map((r) => r.code).join(", ")}`);
  }
  const report = "# R\n\nNorthwind's shares rose 5% on the day of the announcement [1].";
  const outcome = await audit(report, [source(1, "Northwind's shares rose 5% on the day of the announcement, if not more.")]);
  assert.equal(outcome.claims[0].status, "supported");
  assert.equal(repairReportFromClaims(report, outcome.claims).report, report);
  // "…, but did not" is the main predicate denied, not a tail.
  assert.equal(
    auditEvidence({ claim: "Northwind's revenue rose in 2024.", passage: "Northwind's revenue was expected to rise in 2024, but did not." }).contradicted,
    true
  );
});

// ── A source that names its subject once, then uses a pronoun ───────────────

const PRONOUN_SOURCES: Array<[claim: string, passage: string]> = [
  ["The firm was not profitable in 2024", "The firm was profitable in 2023. It was not profitable in 2024."],
  ["The company does not pay a dividend", "The company paid a dividend in 2019. It does not pay a dividend now."],
  ["The vaccine was not approved for children", "The vaccine was approved for adults in 2021. It was not approved for children."],
  ["Northwind was not profitable in 2024", "Northwind was profitable in 2023. The company was not profitable in 2024, its filing shows."],
  ["The firm was not profitable in 2024", "The firm was profitable in 2023, but it was not profitable in 2024."],
];

test("a claim restating its source's negated sentence, whose subject is a pronoun, is not contradicted, end to end through the repair", async () => {
  for (const [sentence, body] of PRONOUN_SOURCES) {
    const direct = auditEvidence({ claim: `${sentence}.`, passage: body });
    assert.equal(direct.contradicted, false, `${sentence}: ${direct.reasons.map((r) => r.code).join(", ")}`);
    const report = `# R\n\n${sentence} [1].`;
    const outcome = await audit(report, [source(1, body)]);
    const [claim] = outcome.claims;
    assert.equal(claim.status, "supported", `${sentence}: ${JSON.stringify(claim.links)}`);
    assert.equal(outcome.judgeCalls, 1, `${sentence}: the judge is asked, not pre-empted`);
    assert.ok(!claim.links.some((l) => l.reasons.some((r) => r.code === "polarity_mismatch")), sentence);
    assert.equal(repairReportFromClaims(report, outcome.claims).report, report, sentence);
  }
});

test("the flip of a claim restating a pronoun sentence is still caught", () => {
  for (const [claim, passage] of [
    ["The firm was profitable in 2024.", "The firm was profitable in 2023. It was not profitable in 2024."],
    ["The company pays a dividend.", "The company paid a dividend in 2019. It does not pay a dividend now."],
    ["The vaccine was approved for children.", "The vaccine was approved for adults in 2021. It was not approved for children."],
    ["Northwind was profitable in 2024.", "Northwind was profitable in 2023. It was not profitable in 2024, its filing shows."],
    ["The firm was profitable in 2024.", "The firm was profitable in 2023, but it was not profitable in 2024."],
    // A negation with "do" puts the verb in its bare form.
    ["The regulator approved the merger.", "The regulator approved the acquisition in 2021. It did not approve the merger."],
    ["Northwind raised prices in 2025.", "Northwind raised prices in 2024, but it did not raise prices in 2025."],
    ["The firm met its emissions target.", "The firm met its sales target in 2022, although it did not meet its emissions target."],
  ]) {
    const result = auditEvidence({ claim: claim!, passage: passage! });
    assert.ok(result.reasons.some((r) => r.code === "polarity_mismatch"), `${claim} <> ${passage}`);
  }
  // Another name ("the company") may be another entity: it is never the proof of a contradiction. The judge reads it.
  for (const [claim, passage] of [
    ["Northwind was profitable in 2024.", "Northwind was profitable in 2023. The company was not profitable in 2024, its filing shows."],
    ["Northwind raised prices in 2025.", "Northwind raised prices in 2024, but the company did not raise prices in 2025."],
  ]) {
    assert.equal(auditEvidence({ claim: claim!, passage: passage! }).contradicted, false, `${claim} <> ${passage}`);
  }
  // The faithful versions of those last three stand.
  for (const [claim, passage] of [
    ["The regulator did not approve the merger.", "The regulator approved the acquisition in 2021. It did not approve the merger."],
    ["Northwind did not raise prices in 2025.", "Northwind raised prices in 2024, but the company did not raise prices in 2025."],
    ["The firm did not meet its emissions target.", "The firm met its sales target in 2022, although it did not meet its emissions target."],
  ]) {
    assert.equal(auditEvidence({ claim: claim!, passage: passage! }).contradicted, false, claim);
  }
});

test("when passage clauses tie for the claim and disagree with each other, the text settles nothing", () => {
  // Both clauses hold two of the claim's three words and nothing tells them
  // apart: the claim may be about either. The judge decides, both ways round.
  const passage = "Northwind was profitable in Asia. The company was not profitable in Europe.";
  for (const claim of ["Northwind was not profitable in Europe.", "Northwind was profitable in Europe."]) {
    const result = auditEvidence({ claim, passage });
    assert.equal(result.contradicted, false, `${claim}: ${result.reasons.map((r) => r.code).join(", ")}`);
  }
  // A date rules the other clause out, but "the company" is still only possibly Northwind: no proof either way.
  const dated = "Northwind was profitable in 2023. The company was not profitable in 2024.";
  assert.equal(auditEvidence({ claim: "Northwind was not profitable in 2024.", passage: dated }).contradicted, false);
  assert.equal(auditEvidence({ claim: "Northwind was profitable in 2024.", passage: dated }).contradicted, false);
  // With a pronoun the denial is Northwind's own, and the clause about 2023 cannot speak for 2024.
  const pronoun = "Northwind was profitable in 2023. It was not profitable in 2024.";
  assert.equal(auditEvidence({ claim: "Northwind was not profitable in 2024.", passage: pronoun }).contradicted, false);
  assert.equal(auditEvidence({ claim: "Northwind was profitable in 2024.", passage: pronoun }).contradicted, true);
});

// ── A title-case word in front of the measured noun is not a subject ──────────

test("another citation never hides a cited passage that gives a different figure: who was told, when, where", async () => {
  const claim = "In 2024, Northwind's revenue was $4.3 billion.";
  for (const passage of [
    "The company told Reuters revenue was $3.9 billion in 2024.",
    "The company said Monday revenue was $3.9 billion in 2024.",
    "On Tuesday revenue was $3.9 billion in 2024.",
    "Speaking in London revenue was $3.9 billion in 2024.",
    "The company told Reuters it made $3.9 billion in 2024.",
  ]) {
    const result = auditEvidence({ claim, passage });
    assert.ok(result.ceiling < SUPPORTED_MIN, `${passage}: ${result.reasons.map((r) => r.code).join(", ")}`);
    assert.equal(result.contradicted, false, passage);
  }

  const report = "# R\n\nIn 2024, Northwind's revenue was $4.3 billion [1][2].";
  for (const one of ["The company told Reuters revenue was $3.9 billion in 2024.", "The company said Monday revenue was $3.9 billion in 2024."]) {
    for (const two of ["Northwind's revenue was $4.3 billion, the wire reported.", "Northwind reported $4.3 billion."]) {
      const [audited] = (await audit(report, [source(1, one), source(2, two)])).claims;
      const fromOne = audited.links.filter((l) => l.sourceIndex === 1);
      // "revenue" with no owner may be Northwind's: the disagreement is shown and judged, never settled as a contradiction.
      assert.ok(fromOne.length > 0 && fromOne.every((l) => l.status !== "supported"), `${one} / ${two}: ${JSON.stringify(audited.links)}`);
      assert.ok(fromOne.every((l) => l.reasons.some((r) => r.code === "figure_differs")), `${one} / ${two}: ${JSON.stringify(audited.links)}`);
      assert.notEqual(audited.status, "contradicted", `${one} / ${two}`);
      if (audited.status === "supported") assert.equal(audited.contested, true, `${one} / ${two}`);
    }
  }
});

test("beside the passage that supports it, a figure for another subject the claim names is no doubt; one for a name the claim never uses is", () => {
  const supporting = "Southwind earned $2.1 billion in 2024.";
  // The claim names Contoso for another subject than the $2.1 billion is about: its figure is not the claim's, and
  // beside the supporting passage it disputes nothing.
  const three = "Northwind earned $4.3 billion in 2024, while Southwind earned $2.1 billion; Contoso trailed both.";
  for (const passage of [
    "Northwind earned $4.3 billion in 2024. Contoso's revenue was $1.0 billion.",
    "Northwind earned $4.3 billion in 2024, while Contoso Group earned $1.0 billion.",
    "Northwind earned $4.3 billion in 2024, and Contoso Labs earned $1.0 billion.",
    "Northwind earned $4.3 billion in 2024, while Contoso earned $1.0 billion.",
  ]) {
    const result = auditEvidence({ claim: three, passage });
    // Each passage is judged on its own text: the $2.1 billion is simply not in it. No other citation supplies it.
    assert.ok(result.reasons.some((r) => r.code === "figure_absent"), `${passage}: ${result.reasons.map((r) => r.code).join(", ")}`);
    assert.ok(result.ceiling < SUPPORTED_MIN, passage);
    assert.equal(result.contradicted, false, passage);
    assert.equal(differsFromSupportingPassage(three, passage, supporting), false, passage);
  }
  // A name the claim never uses is unknown, not another entity: for all the text shows it is Southwind by another
  // name ("GM's" for General Motors, "the Trust's" for Northwind REIT). Beside the passage that states the claim's
  // figure, its own figure is a doubt shown as one.
  const two = "Northwind earned $4.3 billion in 2024, while Southwind earned $2.1 billion.";
  for (const passage of [
    "Northwind earned $4.3 billion in 2024. Contoso's revenue was $3.0 billion.",
    "Northwind earned $4.3 billion in 2024, while Contoso Group earned $3.0 billion.",
    "Northwind earned $4.3 billion in 2024, and Contoso Labs earned $3.0 billion.",
    "Northwind earned $4.3 billion in 2024, while Contoso earned $3.0 billion.",
    "Northwind earned $4.3 billion in 2024, while SW earned $3.0 billion.",
  ]) {
    const result = auditEvidence({ claim: two, passage });
    assert.ok(result.ceiling < SUPPORTED_MIN, passage);
    assert.equal(result.contradicted, false, passage);
    assert.equal(differsFromSupportingPassage(two, passage, supporting), true, passage);
  }
  // Title case is not a name: a capitalised measure ("Top Line reached") leaves the figure this passage's, and a doubt.
  const measure = "Northwind earned $4.3 billion in 2024, while Top Line reached $3.0 billion.";
  assert.ok(auditEvidence({ claim: three, passage: measure }).ceiling < SUPPORTED_MIN);
  assert.equal(differsFromSupportingPassage(three, measure, supporting), true);
  // "Northwind Group" is Northwind: its figure is the claim's subject's.
  const group = auditEvidence({
    claim: "In 2024, Northwind's revenue was $4.3 billion.",
    passage: "Northwind Group's revenue was $3.9 billion in 2024.",
  });
  assert.equal(group.contradicted, true);
});

// ── A verb in front of the measured noun is not a narrower subject ───────────

test("a verb read as the measured noun's qualifier no longer hides a disagreement another citation would have masked", async () => {
  const two = source(2, "Northwind's revenue was $4.3 billion in 2024, the wire reported.");
  for (const one of [
    "The company booked revenue of $3.9 billion in 2024.",
    "The company reported to the SEC revenue of $3.9 billion in 2024.",
    "Northwind logged revenue of $3.9 billion in 2024.",
    "The company achieved revenue of $3.9 billion in 2024.",
  ]) {
    const [claim] = (await audit("# R\n\nIn 2024, Northwind's revenue was $4.3 billion [1][2].", [source(1, one), two])).claims;
    assert.equal(claim.status, "supported", one);
    assert.equal(claim.contested, true, `${one}: ${JSON.stringify(claim.links)}`);
    assert.ok(claim.links.some((l) => l.sourceIndex === 1 && l.stance === "contradicts"), one);
  }
});

test("a narrower subject is still read however the passage words it", () => {
  const claim = "Northwind's revenue was $4.3 billion in 2024.";
  for (const passage of [
    "Its logistics revenue was $1.8 billion in 2024.",
    "Logistics revenue was $1.8 billion in 2024.",
    "In 2024 logistics revenue was $1.8 billion.",
    "The company said logistics revenue was $1.8 billion in 2024.",
    "The company posted logistics revenue of $1.8 billion in 2024.",
    "Growth in cloud revenue took it to $1.8 billion in 2024.",
    "EU revenue was $1.8 billion in 2024.",
    "The company said EU revenue was $1.8 billion in 2024.",
    "Northwind's adjusted revenue was $4.0 billion in 2024.",
    "Northwind's profit was $0.5 billion in 2024.",
  ]) {
    const result = auditEvidence({ claim, passage });
    assert.equal(result.contradicted, false, `${passage}: ${result.reasons.map((r) => r.code).join(", ")}`);
  }
});

// ── Part of a year is not the year ──────────────────────────────────────────

const SUB_PERIODS = [
  "Northwind's fourth-quarter revenue was $1.1 billion in 2024.",
  "In the fourth quarter of 2024, revenue was $1.2 billion.",
  "In the first half of 2024, Northwind's revenue was $2.0 billion.",
  "Revenue in December 2024 was $0.4 billion.",
  "Q4 2024 revenue was $1.2 billion.",
];

test("a quarter, a half or a month of the claim's year does not contest the year's figure, cited or uncited", async () => {
  const report = "# R\n\nNorthwind's revenue was $4.3 billion in 2024 [1].";
  const headline = "Northwind's revenue was $4.3 billion in 2024, the annual report says.";
  for (const part of SUB_PERIODS) {
    for (const sources of [[source(1, `${headline}\n\n${part}`)], [source(1, headline), source(2, part)]]) {
      const [claim] = (await audit(report, sources)).claims;
      assert.equal(claim.status, "supported", part);
      assert.equal(claim.contested, false, `${part}: ${JSON.stringify(claim.links)} ${JSON.stringify(claim.rivals)}`);
      assert.ok(claim.links.every((l) => l.stance === "supports"), part);
      assert.deepEqual(claim.rivals, [], part);
    }
    // Nor, as the only passage, is the part a contradiction of the whole.
    assert.equal(auditEvidence({ claim: "Northwind's revenue was $4.3 billion in 2024.", passage: part }).contradicted, false, part);
  }
});

test("the same part of the year giving a different figure still disagrees; another part does not", async () => {
  const outcome = await audit("# R\n\nNorthwind's fourth-quarter revenue was $1.1 billion in 2024 [1].", [
    source(1, "Northwind's fourth-quarter revenue was $1.1 billion in 2024.\n\nNorthwind's fourth-quarter revenue was $1.3 billion in 2024 after the restatement, the auditors found."),
  ]);
  assert.equal(outcome.claims[0].contested, true);
  for (const [claim, passage, contradicted] of [
    ["Q4 2024 revenue was $1.2 billion.", "Revenue in the fourth quarter of 2024 was $1.4 billion.", true],
    ["Revenue in December 2024 was $0.4 billion.", "December 2024 revenue was $0.5 billion.", true],
    ["Full-year revenue was $4.3 billion in 2024.", "Revenue for the year was $3.9 billion in 2024.", true],
    // The year's figure, but no owner where the claim names Northwind: a disagreement for the judge (figure_differs).
    ["Northwind's revenue was $4.3 billion in 2024.", "Full-year revenue rose to $3.9 billion in 2024 on a strong fourth quarter.", false],
    ["Northwind's revenue was $4.3 billion in 2024.", "Northwind's revenue was $3.9 billion in 2024, the quarterly statistics show.", true],
    // A reading at a date is a moment, not a month's worth.
    ["Installed capacity reached 16.5 GW at the end of June 2026.", "Installed capacity stood at 15.1 GW at the end of June 2026.", true],
    ["Alpha costs $18 a month.", "Alpha costs $20 per month.", true],
    ["Northwind's fourth-quarter revenue was $1.1 billion in 2024.", "Northwind's third-quarter revenue was $1.0 billion in 2024.", false],
    ["Revenue was $4.3 billion in 2024.", "Revenue for the first nine months of 2024 was $3.1 billion.", false],
    ["Northwind paid a dividend of $2.00 in 2024.", "Northwind paid a quarterly dividend of $0.50 in 2024.", false],
  ] as const) {
    const result = auditEvidence({ claim, passage });
    assert.equal(result.contradicted, contradicted, `${claim} <> ${passage}: ${result.reasons.map((r) => r.code).join(", ")}`);
  }
  assert.ok(
    auditEvidence({ claim: "Northwind's revenue was $4.3 billion in 2024.", passage: "Full-year revenue rose to $3.9 billion in 2024 on a strong fourth quarter." }).reasons.some(
      (r) => r.code === "figure_differs"
    )
  );
});

test("an undated figure is not contested by a paragraph its own words place in another period", async () => {
  const report = "# R\n\nNorthwind's revenue was $4.3 billion [1].";
  const supporting = "Northwind's revenue was $4.3 billion in 2024, the annual report says.";
  for (const other of [
    "A year earlier, revenue was $3.9 billion.",
    "Revenue was $3.9 billion in the prior year.",
    "Revenue in FY2023 was $3.9 billion.",
    "Northwind's revenue was $3.9 billion two years ago.",
    "Fourth-quarter revenue was $1.2 billion.",
  ]) {
    const [claim] = (await audit(report, [source(1, `${supporting}\n\n${other}`)])).claims;
    assert.equal(claim.status, "supported", other);
    assert.equal(claim.contested, false, `${other}: ${JSON.stringify(claim.links)}`);
  }
  // The same relative period giving another figure is still a disagreement.
  const [same] = (
    await audit(report, [
      source(1, "Northwind's revenue was $4.3 billion last year, the annual report says.\n\nNorthwind's revenue was $4.1 billion last year after the restatement, the auditors found."),
    ])
  ).claims;
  assert.equal(same.contested, true);
});

test("a fiscal year is a date", () => {
  const result = auditEvidence({ claim: "Revenue in FY2024 was $4.3 billion.", passage: "Revenue in fiscal 2023 was $4.3 billion." });
  assert.ok(result.reasons.some((r) => r.code === "date_absent"), result.reasons.map((r) => r.code).join(", "));
  assert.deepEqual(
    auditEvidence({ claim: "Revenue in FY2024 was $4.3 billion.", passage: "Revenue in fiscal 2024 was $4.3 billion." }).reasons,
    []
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

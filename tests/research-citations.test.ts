import test from "node:test";
import assert from "node:assert/strict";
import {
  PARTIAL_MIN,
  SUPPORTED_MIN,
  auditEvidence,
  authorityOf,
  detectSyndication,
  extractClaims,
  extractEventDate,
  freshnessOf,
  independentWitnessCount,
  parseAnswerSpan,
  resolveClaimStatus,
  scoreSource,
  selectPassagesForClaim,
  splitPassages,
  supportLabel,
  tokenCoverage,
  validateClaimAgainstPassage,
  type CitationJudge,
  type ClaimType,
  type LinkVerdict,
  type PassageDraft,
} from "@/lib/research/claim-analysis";

/*
 * The citation benchmark (program §8.3).
 *
 * The bar is a NUMBER — of 100 factual claims, at least 95 genuinely supported
 * by the passage they cite — so the deliverable is a number, and a number needs
 * a corpus to be measured against. The 44 pairs below are hand-written: each
 * one is a claim, the passage a report cited for it, and a human judgement of
 * whether that citation is honest. They are the ground truth; the validator's
 * precision against them is the headline result.
 *
 * The LLM step is stubbed, and stubbed CREDULOUSLY on purpose. If the stub were
 * an oracle — returning the fixture's own ground truth — the benchmark would
 * measure nothing but itself. So the stubs model the real failure mode of a
 * small utility model asked to grade a citation: it says "supported" for
 * anything that shares vocabulary with the passage. Precision under a stub like
 * that is precision contributed by the deterministic audit, which is the part
 * of the pipeline this repository actually owns.
 *
 * No database, no network, no model — see tests/chat-budget-guard.test.ts for
 * the same dependency-injection technique.
 */

type Truth = "supported" | "partial" | "unsupported" | "contradicted";

interface Fixture {
  id: string;
  claim: string;
  passage: string;
  /** The source's publication date, where it matters to the verdict. */
  publishedAt?: Date;
  claimType?: ClaimType;
  /** The hand-written judgement this benchmark is measured against. */
  truth: Truth;
  /** Why a careful reader would say so. Printed when an assertion fails. */
  why: string;
}

const CORPUS: Fixture[] = [
  // ── Genuinely supported ───────────────────────────────────────────────────
  {
    id: "s01-revenue",
    claim: "Northwind reported revenue of $4.3 billion for the 2024 financial year.",
    passage:
      "Northwind Industries said revenue reached $4.3 billion for the financial year ended 31 December 2024, up from $3.9 billion a year earlier. The figure was driven by its logistics division.",
    truth: "supported",
    why: "Same company, same figure, same year, stated flatly in the passage.",
  },
  {
    id: "s02-unemployment",
    claim: "Unemployment in the eurozone fell to 6.4% in March 2025.",
    passage:
      "Eurostat data published today put eurozone unemployment at 6.4% in March 2025, down a tenth of a point on February. Youth unemployment was unchanged.",
    truth: "supported",
    why: "Figure, region and month all match the passage exactly.",
  },
  {
    id: "s03-percent-spelling",
    claim: "The bank raised its policy rate to 4.5% at the meeting.",
    passage:
      "The bank raised its policy rate to 4.5 per cent at the meeting, its third increase of the cycle. Two members of the committee dissented.",
    truth: "supported",
    why: "'4.5 per cent' and '4.5%' are the same figure written two ways.",
  },
  {
    id: "s04-quote",
    claim: 'The chief executive said the recall was "the largest in the company\'s history".',
    passage:
      'Speaking to reporters, the chief executive said the recall was "the largest in the company\'s history" and that every affected unit would be replaced free of charge.',
    truth: "supported",
    why: "The quoted words appear verbatim in the passage.",
  },
  {
    id: "s05-rounding",
    claim: "About 3.4 million households were connected to the network by the end of the programme.",
    passage:
      "By the end of the programme 3,412,000 households had been connected to the network, the ministry said in its final report.",
    truth: "supported",
    why: "3,412,000 rounds to 3.4 million; the report rounding is honest.",
  },
  {
    id: "s06-iso-date",
    claim: "The satellite launched on 2023-11-04 from the Guiana Space Centre.",
    passage:
      "The satellite launched on 4 November 2023 from the Guiana Space Centre, riding an Ariane 5 on its penultimate flight.",
    truth: "supported",
    why: "Same date in a different notation, same launch site.",
  },
  {
    id: "s07-study",
    claim: "Participants who took the drug showed a 27% reduction in relapse over 12 months.",
    passage:
      "Over 12 months, participants taking the drug showed a 27% reduction in relapse compared with placebo. The trial enrolled 1,840 people across nine centres.",
    truth: "supported",
    why: "Effect size, window and direction all stated in the passage.",
  },
  {
    id: "s08-causal-stated",
    claim: "Output fell because a fire shut the main refinery for six weeks.",
    passage:
      "Output fell sharply after a fire shut the main refinery for six weeks. The operator said the blaze caused the entire decline in the quarter.",
    truth: "supported",
    why: "The passage draws the causal link itself ('caused'), so the claim is not adding one.",
  },
  {
    id: "s09-superlative-stated",
    claim: "It was the largest wildfire recorded in the province.",
    passage:
      "Officials described the blaze as the largest wildfire recorded in the province, exceeding the 2017 season's worst by a wide margin.",
    truth: "supported",
    why: "The superlative is the passage's own wording, not the report's addition.",
  },
  {
    id: "s10-prediction-hedged-source",
    claim: "The agency projects sea level will rise by 30 centimetres by 2050.",
    claimType: "prediction",
    passage:
      "The agency projects that sea level is likely to rise by 30 centimetres by 2050 under its central scenario, with a wider range either side.",
    truth: "supported",
    why: "A hedged source is the right evidence for a claim that presents itself as a projection.",
  },
  {
    id: "s11-attribution-kept",
    claim: "According to the regulator, three operators failed the resilience test.",
    passage:
      "According to the regulator, three operators failed the resilience test conducted in the autumn. The names were withheld pending appeals.",
    truth: "supported",
    why: "The claim keeps the attribution the passage gave it.",
  },
  {
    id: "s12-currency-scale",
    claim: "The fund committed €1.2 billion to grid upgrades.",
    passage:
      "The fund committed €1.2bn to grid upgrades over the next five years, its largest single allocation to transmission.",
    truth: "supported",
    why: "'€1.2bn' and '€1.2 billion' are the same commitment.",
  },
  {
    id: "s13-count",
    claim: "The programme trained 12,000 teachers across 340 schools.",
    passage:
      "In total the programme trained 12,000 teachers across 340 schools, according to figures released at its close.",
    truth: "supported",
    why: "Both counts appear in the passage unchanged.",
  },
  {
    id: "s14-quarter",
    claim: "Shipments grew in Q3 2024 for the first time in two years.",
    passage:
      "Shipments grew in Q3 2024, the first quarterly increase in two years, ending a long contraction in the segment.",
    truth: "supported",
    why: "The quarter, the direction and the 'first in two years' framing are all in the passage.",
  },
  {
    id: "s15-legislation",
    claim: "The act took effect on 1 January 2026 across all member states.",
    passage:
      "The act took effect on 1 January 2026 across all member states, replacing a patchwork of national rules that had applied since 2016.",
    truth: "supported",
    why: "Date and scope both stated.",
  },
  {
    id: "s16-temperature",
    claim: "The city recorded 41.2C on 18 July, its highest July reading.",
    passage:
      "The city recorded 41.2C on 18 July, the highest July reading in the station's series, which begins in 1946.",
    truth: "supported",
    why: "Reading, date and the 'highest July' framing all come from the passage.",
  },

  // ── Partially supported: the passage is on topic but does not close the claim
  {
    id: "p01-hedged-to-settled",
    claim: "The merger closed in October, giving the combined group a third of the market.",
    passage:
      "The merger is expected to close in October, giving the combined group about a third of the market, people familiar with the talks said.",
    truth: "partial",
    why: "The passage says the merger is expected to close; the claim reports it as done.",
  },
  {
    id: "p02-superlative-added",
    claim: "It was the first time a private company had docked with the station.",
    passage:
      "The capsule docked with the station on Tuesday after a nineteen-hour approach, and the crew opened the hatch two hours later.",
    truth: "partial",
    why: "The docking is supported; 'the first time' is the report's own addition.",
  },
  {
    id: "p03-causation-added",
    claim: "Rents rose sharply in the city because the new zoning rules cut approvals.",
    passage:
      "Rents rose sharply in the city over the same period in which the new zoning rules were introduced and approvals declined.",
    truth: "partial",
    why: "The passage puts the two side by side; the claim asserts one caused the other.",
  },
  {
    id: "p04-estimate-to-fact",
    claim: "The outbreak affected 240,000 people.",
    passage:
      "The ministry estimates the outbreak affected 240,000 people, though it cautioned that reporting in rural districts was incomplete.",
    truth: "partial",
    why: "An estimate the source itself flags as incomplete, presented as a count.",
  },
  {
    id: "p05-thin-overlap",
    claim:
      "The Lisbon plant will employ 900 people and begin producing cathode material for European carmakers in 2027.",
    passage:
      "The company confirmed it is proceeding with the Lisbon plant. Details of staffing and the production schedule have not been finalised.",
    truth: "partial",
    why: "The plant is confirmed; the headcount, the product and the year are not.",
  },
  {
    id: "p06-alleged",
    claim: "Two executives diverted funds to a shell company in Cyprus.",
    passage:
      "Prosecutors allege that two executives diverted funds to a shell company in Cyprus. Both deny wrongdoing and no charges have been filed.",
    truth: "partial",
    why: "An allegation under investigation, written up as a finding.",
  },
  {
    id: "p07-only",
    claim: "It is the only country in the region to have met the target.",
    passage:
      "The country met the target ahead of the deadline, according to the secretariat's compliance table published this week.",
    truth: "partial",
    why: "Meeting the target is supported; 'the only country' is not in the passage.",
  },
  {
    id: "p08-partial-scope",
    claim: "The ban covers single-use plastics, packaging foam and disposable vapes.",
    passage:
      "The ban covers single-use plastics. Packaging foam is dealt with under a separate instrument that has not yet been laid before parliament.",
    truth: "partial",
    why: "One of three listed items is supported; the passage contradicts nothing but covers little.",
  },

  // ── Unsupported: the passage does not carry the claim at all ──────────────
  {
    id: "u01-figure-absent",
    claim: "The scheme cost taxpayers £2.7 billion.",
    passage:
      "The scheme was wound up after four years. The department said a full accounting of its costs would be published in due course.",
    truth: "unsupported",
    why: "The passage names no cost at all; the figure came from somewhere else.",
  },
  {
    id: "u02-date-absent",
    claim: "The treaty was signed in 1997.",
    passage:
      "The treaty was signed in Kyoto after two weeks of negotiation, and entered into force some years later once the ratification threshold was met.",
    truth: "unsupported",
    why: "The passage places the signing nowhere in time.",
  },
  {
    id: "u03-publication-date-trap",
    claim: "The merger was completed in 2026.",
    publishedAt: new Date("2026-02-11T00:00:00Z"),
    passage:
      "The merger was completed in 2019 after a two-year antitrust review. The combined group has since divested its European retail arm.",
    truth: "unsupported",
    why: "2026 is when this page was published; the event it describes happened in 2019.",
  },
  {
    id: "u04-quote-fabricated",
    claim: 'The minister called the policy "a catastrophic failure of nerve".',
    passage:
      "The minister was critical of the policy in an interview, saying it had not gone far enough and that the department would revisit it.",
    truth: "unsupported",
    why: "Nothing resembling that quotation is in the passage.",
  },
  {
    id: "u05-quote-tidied",
    claim: 'The report concluded there was "no material risk to depositors at any point".',
    passage:
      "The report concluded that risks to depositors had been contained, while noting that the bank's liquidity buffer fell below its internal floor for two days.",
    truth: "unsupported",
    why: "The quotation is a tidied-up paraphrase, and the passage contains a caveat it drops.",
  },
  {
    id: "u06-off-topic",
    claim: "Insulin prices in the United States fell by a third after the 2023 cap took effect.",
    passage:
      "The company's dermatology portfolio grew steadily through the period, with the psoriasis franchise contributing most of the increase in the second half.",
    truth: "unsupported",
    why: "The cited passage is about a different product line entirely.",
  },
  {
    id: "u07-off-topic-shared-words",
    claim: "The hospital reduced waiting times by 40% after hiring 60 nurses.",
    passage:
      "The hospital opened a new wing this spring. Nurses at the site have been consulted about the layout of the wards and the location of the staff room.",
    truth: "unsupported",
    why: "It shares 'hospital' and 'nurses' with the claim and supports none of it.",
  },
  {
    id: "u08-percent-absent",
    claim: "Turnout among under-25s reached 58%.",
    passage:
      "Turnout among under-25s was described by the commission as markedly higher than in the previous cycle, without a figure being released.",
    truth: "unsupported",
    why: "The passage explicitly says no figure was released.",
  },
  {
    id: "u09-wrong-year-both-present",
    claim: "The factory opened in 2019.",
    publishedAt: new Date("2021-06-02T00:00:00Z"),
    passage: "The factory opened in 2021 after construction delays pushed the schedule back by two years.",
    truth: "unsupported",
    why: "The passage names a different year for the same event.",
  },
  {
    id: "u10-figure-absent-count",
    claim: "The union represents 45,000 drivers.",
    passage:
      "The union represents drivers at the three largest depots and has been recognised for collective bargaining since the 1980s.",
    truth: "unsupported",
    why: "No membership figure is in the passage.",
  },
  {
    id: "u11-no-overlap-numbers-only",
    claim: "Global shipments of the device reached 12 million units in 2024.",
    passage:
      "Retailers reported strong demand over the holiday period, with several chains sold out by the middle of December.",
    truth: "unsupported",
    why: "The passage gives no shipment figure and no year.",
  },
  {
    id: "u12-date-only-in-publication",
    claim: "The vaccine was approved in 2025.",
    publishedAt: new Date("2025-09-30T00:00:00Z"),
    passage:
      "The vaccine cleared its final regulatory hurdle after a review that ran through two advisory committee meetings. Distribution begins next month.",
    truth: "unsupported",
    why: "The only 2025 available is the page's own publication date.",
  },

  // ── Contradicted: the passage says the opposite ───────────────────────────
  {
    id: "c01-polarity-approval",
    claim: "The regulator approved the merger.",
    passage: "The regulator did not approve the merger, citing overlapping market share in three regions.",
    truth: "contradicted",
    why: "The passage negates exactly what the claim asserts.",
  },
  {
    id: "c02-percent-mismatch",
    claim: "Emissions fell by 12% over the decade.",
    passage: "Emissions fell by 21% over the decade, the inventory shows, with most of the reduction after 2016.",
    truth: "contradicted",
    why: "Same measure, different figure — a transposition, not an omission.",
  },
  {
    id: "c03-currency-mismatch",
    claim: "The settlement was $50 million.",
    passage: "The settlement was $500 million, one of the largest ever agreed in the sector.",
    truth: "contradicted",
    why: "An order-of-magnitude error against a figure the passage states plainly.",
  },
  {
    id: "c04-evidence-negation",
    claim: "The trial found evidence of harm at low doses.",
    passage: "The trial found no evidence of harm at low doses, and the safety board recommended continuing.",
    truth: "contradicted",
    why: "'found no evidence' against 'found evidence'.",
  },
  {
    id: "c05-decision-flip",
    claim: "The board accepted the proposal.",
    passage: "The board rejected the proposal after a three-hour session, sending it back for revision.",
    truth: "contradicted",
    why: "Rejected is the opposite of accepted.",
  },
  {
    id: "c06-count-mismatch",
    claim: "Seventeen people were injured in the derailment.",
    passage: "Seventy people were injured in the derailment, eleven of them seriously, the health authority said.",
    truth: "contradicted",
    why: "The casualty count is wrong against a figure the passage gives.",
  },
  {
    id: "c07-direction",
    claim: "Applications did not fall after the fee was introduced.",
    passage: "Applications fell after the fee was introduced, dropping most steeply among first-time applicants.",
    truth: "contradicted",
    why: "The claim's negation is the passage's assertion.",
  },
  {
    id: "c08-rate-mismatch",
    claim: "The bank held its policy rate at 3.25%.",
    passage: "The bank cut its policy rate to 2.75%, its first reduction since the tightening cycle began.",
    truth: "contradicted",
    why: "Different rate, and the passage describes a cut rather than a hold.",
  },
];

// ---------------------------------------------------------------------------
// Stubbed judges
// ---------------------------------------------------------------------------

/**
 * The realistic small-model failure mode: shared vocabulary reads as support.
 * This is not a strawman — it is what an unbounded utility-model judge does,
 * and it is the reason the deterministic audit exists.
 */
const optimisticJudge: CitationJudge = async ({ claim, passage }) => {
  const coverage = tokenCoverage(claim, passage);
  return coverage >= 0.2
    ? { verdict: "supported", strength: 0.85, reason: "shares subject matter" }
    : { verdict: "unsupported", strength: 0.1, reason: "unrelated" };
};

/** The worst case: a judge that rubber-stamps everything put in front of it. */
const credulousJudge: CitationJudge = async () => ({ verdict: "supported", strength: 0.98 });

/** No model answered — the degraded path. */
const unavailableJudge: CitationJudge = async () => null;

interface Measurement {
  precision: number;
  recall: number;
  predictedSupported: number;
  falsePositives: Fixture[];
  results: Array<{ fixture: Fixture; verdict: LinkVerdict }>;
}

async function measure(judge: CitationJudge): Promise<Measurement> {
  const results: Measurement["results"] = [];
  for (const fixture of CORPUS) {
    const verdict = await validateClaimAgainstPassage({
      claim: fixture.claim,
      claimType: fixture.claimType,
      passage: fixture.passage,
      publishedAt: fixture.publishedAt ?? null,
      judge,
    });
    results.push({ fixture, verdict });
  }
  const predicted = results.filter((r) => r.verdict.status === "supported");
  const truePositives = predicted.filter((r) => r.fixture.truth === "supported");
  const trulySupported = CORPUS.filter((f) => f.truth === "supported").length;
  return {
    precision: predicted.length === 0 ? 1 : truePositives.length / predicted.length,
    recall: trulySupported === 0 ? 1 : truePositives.length / trulySupported,
    predictedSupported: predicted.length,
    falsePositives: predicted.filter((r) => r.fixture.truth !== "supported").map((r) => r.fixture),
    results,
  };
}

function report(name: string, m: Measurement): string {
  const lines = [
    `${name}: precision ${(m.precision * 100).toFixed(1)}% over ${m.predictedSupported} claims marked supported, recall ${(m.recall * 100).toFixed(1)}%`,
  ];
  for (const f of m.falsePositives) lines.push(`  FALSE POSITIVE ${f.id} (${f.truth}) — ${f.why}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The headline result
// ---------------------------------------------------------------------------

test("the corpus is big enough, and covers all four verdicts", () => {
  assert.ok(CORPUS.length >= 40, `corpus is ${CORPUS.length} pairs, the benchmark needs at least 40`);
  const ids = new Set(CORPUS.map((f) => f.id));
  assert.equal(ids.size, CORPUS.length, "fixture ids must be unique");
  for (const truth of ["supported", "partial", "unsupported", "contradicted"] as const) {
    assert.ok(CORPUS.filter((f) => f.truth === truth).length >= 8, `too few ${truth} fixtures to measure anything`);
  }
});

test("precision of the supported verdict clears the 95% bar", async () => {
  const m = await measure(optimisticJudge);
  console.log(report("optimistic judge", m));
  assert.ok(m.precision >= 0.95, report("precision below the §8.3 bar", m));
});

test("precision holds even when the model rubber-stamps every pair", async () => {
  // If precision came from the judge, this run would collapse. It does not,
  // because the audit's ceilings are what decide the supported verdict.
  const m = await measure(credulousJudge);
  console.log(report("credulous judge", m));
  assert.ok(m.precision >= 0.95, report("precision below the bar under a credulous judge", m));
});

test("the validator still finds most genuinely supported claims", async () => {
  // Precision is trivial to buy by marking everything unsupported. This is the
  // price check: the audit must not be so suspicious that it destroys the
  // report's citations wholesale.
  const m = await measure(optimisticJudge);
  assert.ok(m.recall >= 0.85, report("recall collapsed — the audit is over-firing", m));
});

test("every unsupported and contradicted pair is marked, never left looking cited", async () => {
  const m = await measure(optimisticJudge);
  for (const { fixture, verdict } of m.results) {
    if (fixture.truth === "supported") continue;
    assert.notEqual(
      verdict.status,
      "supported",
      `${fixture.id} was marked supported but is ${fixture.truth}: ${fixture.why}`
    );
    assert.ok(
      verdict.status === "unsupported" || verdict.status === "contradicted",
      `${fixture.id} must carry an explicit status, got ${verdict.status}`
    );
  }
});

test("contradictions are called contradictions, not silence", async () => {
  const m = await measure(optimisticJudge);
  const contradicted = m.results.filter((r) => r.fixture.truth === "contradicted");
  const caught = contradicted.filter((r) => r.verdict.status === "contradicted");
  console.log(`contradiction detection: ${caught.length}/${contradicted.length}`);
  // A contradicted claim reported as merely unsupported understates the problem:
  // the reader needs to know the source says the opposite, not that it is quiet.
  assert.ok(
    caught.length / contradicted.length >= 0.85,
    `only ${caught.length}/${contradicted.length} contradictions were identified as such`
  );
  for (const r of caught) assert.equal(r.verdict.stance, "contradicts");
});

test("a claim marked unsupported carries a reason a reader can check", async () => {
  const m = await measure(optimisticJudge);
  for (const { fixture, verdict } of m.results) {
    if (fixture.truth === "supported") continue;
    assert.ok(
      verdict.reasons.length > 0,
      `${fixture.id} was marked ${verdict.status} with no reason to show in the inspector`
    );
  }
});

test("with no model available nothing is marked supported, and nothing is marked unsupported either", async () => {
  const m = await measure(unavailableJudge);
  const statuses = new Set(m.results.map((r) => r.verdict.status));
  // Contradictions are settled by the text alone, so they survive the outage.
  assert.deepEqual([...statuses].sort(), ["contradicted", "unverified"]);
  for (const { fixture, verdict } of m.results) {
    if (verdict.status !== "unverified") continue;
    assert.equal(verdict.degraded, true, `${fixture.id} must be flagged degraded, not quietly unsupported`);
  }
});

test("a judge that says unsupported can never be overridden into supported", async () => {
  const strict: CitationJudge = async () => ({ verdict: "unsupported", strength: 0.99, reason: "no entailment" });
  const verdict = await validateClaimAgainstPassage({
    claim: CORPUS[0].claim,
    passage: CORPUS[0].passage,
    judge: strict,
  });
  assert.equal(verdict.status, "unsupported");
  assert.ok(verdict.strength < SUPPORTED_MIN);
});

// ---------------------------------------------------------------------------
// The pieces the headline number rests on
// ---------------------------------------------------------------------------

test("the audit only ever lowers a score", async () => {
  for (const fixture of CORPUS) {
    const audit = auditEvidence({ claim: fixture.claim, passage: fixture.passage, publishedAt: fixture.publishedAt });
    assert.ok(audit.ceiling >= 0 && audit.ceiling <= 1, `${fixture.id} ceiling out of range`);
    if (fixture.truth === "supported") {
      assert.ok(
        audit.ceiling >= SUPPORTED_MIN,
        `${fixture.id} is genuinely supported but the audit capped it at ${audit.ceiling}: ${audit.reasons
          .map((r) => r.code)
          .join(", ")}`
      );
    }
  }
});

test("a publication date is not an event date", () => {
  const passage =
    "The merger was completed in 2019 after a two-year antitrust review. The combined group has since divested its European retail arm.";
  const event = extractEventDate(passage, new Date("2026-02-11T00:00:00Z"));
  assert.equal(event?.year, 2019);

  // And the audit names the trap by its right name, so the inspector can say so.
  const audit = auditEvidence({
    claim: "The merger was completed in 2026.",
    passage,
    publishedAt: new Date("2026-02-11T00:00:00Z"),
  });
  assert.ok(audit.reasons.some((r) => r.code === "date_is_publication_date"));
});

test("supportLabel splits a near miss from a passage about something else", () => {
  assert.equal(supportLabel("supported", 0.9), "supported");
  assert.equal(supportLabel("unsupported", PARTIAL_MIN + 0.05), "partially supported");
  assert.equal(supportLabel("unsupported", 0.1), "unsupported");
  assert.equal(supportLabel("contradicted", 0), "contradicted");
  assert.equal(supportLabel("unverified", null), "unverified");
});

// ---------------------------------------------------------------------------
// Claim extraction
// ---------------------------------------------------------------------------

const REPORT = `# Offshore wind in the North Sea

## Capacity

Installed capacity reached 32 GW at the end of 2024 [1]. The Dogger Bank
project alone accounts for 3.6 GW [1][2].

This section sets out what the figures show.

- Auction prices fell to £44 per MWh in the most recent round [3].

\`\`\`
capacity_gw = 32  # 2024, not a claim
\`\`\`

## Sources
[1] Wind Europe statistics — https://windeurope.org/stats
[2] Dogger Bank — https://doggerbank.com
[3] Auction results — https://gov.uk/auction`;

test("extraction keeps the load-bearing sentences and their spans", () => {
  const claims = extractClaims(REPORT);
  const texts = claims.map((c) => c.text);

  assert.ok(texts.some((t) => t.startsWith("Installed capacity reached 32 GW")));
  assert.ok(texts.some((t) => t.includes("Dogger Bank")));
  assert.ok(texts.some((t) => t.includes("£44 per MWh")), "a list item is still a claim");

  // Framing, headings, code and the reference list assert nothing.
  assert.ok(!texts.some((t) => t.includes("This section sets out")));
  assert.ok(!texts.some((t) => t.includes("capacity_gw")));
  assert.ok(!texts.some((t) => t.includes("windeurope.org")));

  for (const claim of claims) {
    const span = parseAnswerSpan(claim.answerSpan);
    assert.ok(span, `${claim.text} has no usable answerSpan`);
    // The span must actually point at the claim in the report — the UI marks it.
    const sliced = REPORT.slice(span.start, span.end).replace(/\[\d+\]/g, "").replace(/\s+/g, " ").trim();
    assert.ok(sliced.length > 0);
    assert.ok(claim.text.startsWith(sliced.slice(0, 12)), `span for "${claim.text}" points at "${sliced}"`);
  }
});

test("citation markers become source indices, deduplicated and in order", () => {
  const claims = extractClaims(REPORT);
  const dogger = claims.find((c) => c.text.includes("Dogger Bank"));
  assert.deepEqual(dogger?.citations, [1, 2]);
});

test("a load-bearing sentence with no citation is a claim, and resolves to unsupported", () => {
  const claims = extractClaims("The plant will produce 40,000 tonnes of lithium hydroxide a year.");
  assert.equal(claims.length, 1);
  assert.deepEqual(claims[0].citations, []);
  // Nothing to validate against — but it is not dropped, which is the point.
  assert.deepEqual(resolveClaimStatus([]), { status: "unsupported", supportStrength: 0 });
});

test("a claim's status is the best of its links, and a contradiction stays visible", () => {
  const supported: LinkVerdict = {
    status: "supported",
    stance: "supports",
    strength: 0.82,
    label: "supported",
    reasons: [],
    degraded: false,
  };
  const contradicted: LinkVerdict = {
    status: "contradicted",
    stance: "contradicts",
    strength: 0,
    label: "contradicted",
    reasons: [],
    degraded: false,
  };
  assert.deepEqual(resolveClaimStatus([supported, contradicted]), { status: "supported", supportStrength: 0.82 });
  assert.deepEqual(resolveClaimStatus([contradicted]), { status: "contradicted", supportStrength: 0 });
  assert.equal(resolveClaimStatus([{ ...supported, status: "unverified", degraded: true, strength: 0 }]).status, "unverified");
});

// ---------------------------------------------------------------------------
// Passages and linking
// ---------------------------------------------------------------------------

test("passages carry a locator that points back into the snapshot", () => {
  const body = [
    "Installed offshore wind capacity in the North Sea reached 32 GW at the end of 2024, according to the association's annual statistics release.",
    "The Dogger Bank project alone accounts for 3.6 GW of that total once its third phase is energised, making it the largest single site in the basin.",
  ].join("\n\n");
  const passages = splitPassages(body);
  assert.ok(passages.length >= 2);
  for (const p of passages) {
    const m = /^chars:(\d+)-(\d+)$/.exec(p.locator);
    assert.ok(m, `locator ${p.locator} is not a char range`);
    assert.ok(body.slice(Number(m[1]), Number(m[2])).includes(p.text.slice(0, 30)));
  }
});

test("linking picks the passage that carries the figure, not the one that shares the topic", () => {
  const passages: PassageDraft[] = [
    { text: "Offshore wind has grown quickly in the North Sea over the past decade, driven by falling turbine costs.", locator: "chars:0-100", ordinal: 0 },
    { text: "Installed capacity in the North Sea reached 32 GW at the end of 2024.", locator: "chars:100-170", ordinal: 1 },
  ];
  const [claim] = extractClaims("Installed capacity reached 32 GW at the end of 2024 [1].");
  const links = selectPassagesForClaim(claim, new Map([[1, passages]]), { perSource: 1 });
  assert.equal(links.length, 1);
  assert.equal(links[0].passage.ordinal, 1, "the passage holding the figure must win");
});

// ---------------------------------------------------------------------------
// Source scoring and syndication
// ---------------------------------------------------------------------------

test("authority separates a statistics office from a forum post", () => {
  assert.ok(authorityOf("https://www.ons.gov.uk/releases/x") > authorityOf("https://reuters.com/a"));
  assert.ok(authorityOf("https://reuters.com/a") > authorityOf("https://medium.com/@someone/a"));
  assert.ok(authorityOf("https://medium.com/@someone/a") > authorityOf("https://reddit.com/r/x"));
});

test("freshness is measured against the event, not against today", () => {
  const event = new Date("2019-06-01T00:00:00Z");
  const contemporaneous = freshnessOf({ publishedAt: new Date("2019-06-03T00:00:00Z"), eventDate: event });
  const retrospective = freshnessOf({ publishedAt: new Date("2025-06-03T00:00:00Z"), eventDate: event });
  assert.ok(contemporaneous > 0.95, "a report filed two days after the event is as fresh as it gets");
  assert.ok(retrospective < 0.2, "a write-up six years later is recollection, not reporting");
  assert.equal(freshnessOf({ publishedAt: null }), 0.35, "an undated page is a defect, not a disqualification");
});

test("directness separates a filing from a rewrite of one", () => {
  const primary = scoreSource({
    url: "https://sec.gov/filing",
    text: "In a statement filed with the commission, the company said it had completed the sale.",
  });
  const secondary = scoreSource({
    url: "https://sec.gov/filing",
    text: "According to a person familiar with the matter, and as reported by another outlet citing that person, the sale is complete.",
  });
  assert.ok(primary.directness > secondary.directness);
});

test("two copies of one wire story count as one witness", () => {
  const wire =
    "(Reuters) - The central bank cut its policy rate to 2.75% on Thursday, the first reduction since the tightening cycle began in 2022. Officials said inflation had returned to target and that further moves would depend on incoming data. The decision was unanimous.";
  const sources = [
    { id: "src-wire", url: "https://reuters.com/markets/rate-cut", title: "Central bank cuts rate to 2.75%", text: wire, publishedAt: new Date("2026-03-05T09:00:00Z") },
    {
      id: "src-reprint",
      url: "https://dailyexample.com/business/rate-cut",
      title: "Central bank cuts rate to 2.75%",
      // A syndicator's cut: the same paragraphs, one dropped.
      text:
        "(Reuters) - The central bank cut its policy rate to 2.75% on Thursday, the first reduction since the tightening cycle began in 2022. Officials said inflation had returned to target and that further moves would depend on incoming data.",
      publishedAt: new Date("2026-03-05T14:30:00Z"),
    },
    {
      id: "src-independent",
      url: "https://ons.gov.uk/statistics/rates",
      title: "Official bank rate history",
      text:
        "The official bank rate series records a reduction to 2.75% effective 5 March 2026. Previous changes in the series are listed with their effective dates and the minutes that accompanied them.",
      publishedAt: new Date("2026-03-06T00:00:00Z"),
    },
  ];

  const duplicates = detectSyndication(sources);
  assert.equal(duplicates.get("src-reprint"), "src-wire", "the reprint must point at the wire it came from");
  assert.equal(duplicates.has("src-wire"), false, "the earliest publisher is the canonical row");
  assert.equal(duplicates.has("src-independent"), false, "a genuinely separate source must not be collapsed");

  assert.equal(independentWitnessCount(["src-wire", "src-reprint"], duplicates), 1);
  assert.equal(independentWitnessCount(["src-wire", "src-reprint", "src-independent"], duplicates), 2);

  // And the score has to say it too, or the run loop would still weigh it twice.
  const reprint = scoreSource({ url: sources[1].url, text: sources[1].text, duplicate: true });
  assert.equal(reprint.independence, 0);
  assert.equal(reprint.composite, 0);
});

test("two different stories about the same subject are not syndication", () => {
  const duplicates = detectSyndication([
    {
      id: "a",
      url: "https://bbc.co.uk/news/rate-cut",
      title: "Bank cuts rates as inflation eases",
      text: "The Bank cut its policy rate on Thursday, the first reduction in three years. Businesses welcomed the move while savers warned of lower returns.",
    },
    {
      id: "b",
      url: "https://theguardian.com/business/rate-cut",
      title: "What the rate cut means for mortgages",
      text: "Homeowners on tracker mortgages will see payments fall within weeks. Fixed-rate borrowers will not benefit until they remortgage, brokers said.",
    },
  ]);
  assert.equal(duplicates.size, 0);
});

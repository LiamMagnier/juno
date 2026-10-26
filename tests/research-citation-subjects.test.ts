import test from "node:test";
import assert from "node:assert/strict";
import { SUPPORTED_MIN, auditEvidence, repairReportFromClaims, type CitationJudge } from "@/lib/research/claim-analysis";
import { auditClaims, selectClaimsForAudit, type AuditSource } from "@/lib/research/citation-audit-core";

/*
 * How the deterministic citation audit reads a SUBJECT: a source that names
 * a subject of several words once and then carries it on with a pronoun or
 * another name (the polarity check), and title case that is not a name (the
 * corroboration rule). The judge is stubbed credulous, so a pass means the
 * text checks did the work — and a false contradiction shows as one, because
 * it pre-empts the judge (judgeCalls 0).
 */

const credulous: CitationJudge = async () => ({ verdict: "supported", strength: 0.95 });
const ASOF = new Date("2026-10-25T12:00:00Z");

function source(index: number, body: string): AuditSource {
  return {
    index,
    title: `Source ${index}`,
    url: `https://s${index}.example/page`,
    publishedAt: null,
    truncated: false,
    passages: body
      .split(/\n{2,}/)
      .map((text, ordinal) => ({ text, locator: `chars:${ordinal * 1000}-${ordinal * 1000 + text.length}`, ordinal })),
  };
}

async function audit(report: string, sources: AuditSource[]) {
  return auditClaims({ claims: selectClaimsForAudit(report, 40), sources, judge: credulous, judgeCap: 100, asOf: ASOF });
}

const polarity = (claim: string, passage: string) =>
  auditEvidence({ claim, passage }).reasons.some((r) => r.code === "polarity_mismatch");

// ── Polarity: the predicate decides, not the clause holding the subject's words ──

/** A faithful restatement of a denial the source makes after naming its subject once. */
const DENIALS: Array<[claim: string, passage: string]> = [
  // A pronoun.
  ["The European Central Bank did not raise interest rates in 2024", "The European Central Bank raised interest rates in 2023. It did not raise interest rates in 2024."],
  ["The UK Competition and Markets Authority did not block the merger", "The UK Competition and Markets Authority blocked the Activision deal in 2023. It did not block the merger."],
  ["Northwind Logistics Group was not profitable in 2024", "Northwind Logistics Group was profitable in 2023. It was not profitable in 2024."],
  ["The new malaria vaccine was not approved for children", "The new malaria vaccine was approved for adults in 2021. It was not approved for children."],
  ["The Golden Gate Bridge did not close in 2024", "The Golden Gate Bridge closed for repairs in 2019, but it did not close in 2024."],
  ["Global sales of the device did not grow in 2024", "Global sales of the device grew strongly in 2023. They did not grow in 2024."],
  // Another name for the subject.
  ["The European Commission did not fine Apple", "The European Commission fined Google in 2018, but the regulator did not fine Apple."],
  ["Northwind Group did not reach its hiring goal in 2024", "Northwind Group reached its revenue goal in 2024. The company did not reach its hiring goal in 2024."],
  ["The new vaccine was not approved for children", "The new vaccine was approved for adults in 2021, while the shot was not approved for children."],
  ["The city council has not approved the stadium plan", "The city council approved the housing plan in March; the council has not approved the stadium plan."],
  ["Acme Robotics does not sell its robots in China", "Acme Robotics sells its robots in Japan and Korea. The startup does not sell its robots in China."],
  ["The Federal Reserve did not cut interest rates in June", "The Federal Reserve cut interest rates in March. The central bank did not cut interest rates in June."],
  ["The International Monetary Fund did not approve the loan", "The International Monetary Fund approved a smaller package in May. The fund did not approve the loan."],
];

test("a claim restating a denial its source makes with a pronoun or another name is not contradicted, end to end through the repair", async () => {
  for (const [sentence, body] of DENIALS) {
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

test("the flip of a claim whose source carries its subject on with a pronoun is caught", () => {
  for (const [claim, passage] of [
    ["The European Central Bank raised interest rates in 2024.", "The European Central Bank raised interest rates in 2023. It did not raise interest rates in 2024."],
    ["Northwind Logistics Group was profitable in 2024.", "Northwind Logistics Group was profitable in 2023. It was not profitable in 2024."],
    ["The new malaria vaccine was approved for children.", "The new malaria vaccine was approved for adults in 2021. It was not approved for children."],
    ["The Golden Gate Bridge closed in 2024.", "The Golden Gate Bridge closed for repairs in 2019, but it did not close in 2024."],
    ["The UK Competition and Markets Authority blocked the merger.", "The UK Competition and Markets Authority blocked the Activision deal in 2023. It did not block the merger."],
  ]) {
    assert.ok(polarity(claim!, passage!), `${claim} <> ${passage}`);
  }
});

test("subjects of one, two and three words read alike: no false contradiction, every flip caught", () => {
  const subjects = ["The regulator", "Northwind", "The national regulator", "Northwind Logistics", "The European Central Bank", "The new budget airline"];
  const predicates: Array<[positive: string, negative: string, other: string]> = [
    ["was profitable in 2024", "was not profitable in 2024", "was profitable in 2023"],
    ["approved the merger", "did not approve the merger", "approved the acquisition in 2021"],
    ["raised prices in 2025", "did not raise prices in 2025", "raised prices in 2024"],
    ["met its emissions target", "did not meet its emissions target", "met its sales target in 2022"],
  ];
  const forms = [
    (s: string, other: string, said: string) => `${s} ${other}. It ${said}.`,
    (s: string, other: string, said: string) => `${s} ${other}, but it ${said}.`,
  ];
  const falseContradictions: string[] = [];
  const missedFlips: string[] = [];
  for (const s of subjects) {
    for (const [positive, negative, other] of predicates) {
      for (const form of forms) {
        for (const said of [positive, negative]) {
          const passage = form(s, other, said);
          if (polarity(`${s} ${said}.`, passage)) falseContradictions.push(`${s} ${said} <> ${passage}`);
          const flipped = said === positive ? negative : positive;
          if (!polarity(`${s} ${flipped}.`, passage)) missedFlips.push(`${s} ${flipped} <> ${passage}`);
        }
      }
    }
  }
  assert.deepEqual(falseContradictions, []);
  assert.deepEqual(missedFlips, []);
});

test("when the clause the subject picks and the clause the predicate picks disagree, the text settles nothing", () => {
  for (const [claim, passage] of [
    // Another name may be another entity: the judge decides, both ways round.
    ["The Federal Reserve cut interest rates in June.", "The Federal Reserve cut interest rates in March. The central bank did not cut interest rates in June."],
    ["The Federal Reserve did not cut rates for borrowers.", "The Federal Reserve cut rates for savers. The central bank did not cut rates for borrowers."],
    // Another subject denying the same predicate.
    ["Alpha raised prices in 2024.", "Alpha raised its prices sharply in 2024. Beta did not raise prices in 2024."],
    // Denying a narrower statement than the claim's.
    ["Northwind opened a factory.", "Northwind opened a factory in Ohio in 2024. It did not open a factory in Texas."],
  ]) {
    assert.equal(polarity(claim!, passage!), false, `${claim} <> ${passage}`);
  }
});

test("a neighbouring sentence about another year never contradicts the claim's own sentence", () => {
  for (const [claim, passage] of [
    ["Northwind raised prices in 2024.", "Northwind did not raise prices in 2023. Northwind raised prices in 2024 after a strong year of sales growth."],
    ["Northwind raised prices in 2024.", "Northwind raised prices in 2024 after a strong year of sales growth. It did not raise prices in 2023."],
    ["The regulator approved the merger in 2023.", "The regulator approved the merger in 2023. It did not approve the merger in 2024."],
    ["The European Central Bank raised interest rates in 2023.", "The European Central Bank raised interest rates in 2023. It did not raise interest rates in 2024."],
  ]) {
    const result = auditEvidence({ claim: claim!, passage: passage! });
    assert.equal(result.contradicted, false, `${claim} <> ${passage}: ${result.reasons.map((r) => r.code).join(", ")}`);
  }
});

test("an elided negation agreeing with the claim is the clause it is about; one denying it still contradicts", () => {
  assert.equal(polarity("Beta did not raise prices in 2024.", "Alpha raised prices in 2024. Beta did not."), false);
  assert.equal(polarity("Profits did not rise in 2024.", "Sales rose in 2024, but profits did not."), false);
  assert.equal(polarity("Beta raised prices in 2024.", "Alpha raised prices in 2024. Beta did not."), true);
  assert.equal(polarity("Profits rose in 2024.", "Sales rose in 2024, but profits did not."), true);
});

// ── Corroboration: title case is not a name ─────────────────────────────────

/** Headline-style and title-case passages giving a different figure than the claim. */
const TITLE_CASE_RIVALS = [
  "Global Revenue Was $3.9 Billion In 2024.",
  "Worldwide Revenue Reached $3.9 Billion In 2024.",
  "Gross Revenue Hit $3.9 Billion In 2024.",
  "Company Revenue Fell To $3.9 Billion In 2024.",
  "Business Revenue Totalled $3.9 Billion In 2024.",
  "The results are in. Global Revenue Was $3.9 Billion In 2024, the release said.",
];

test("a title-case or headline passage giving a different figure is never shown as support through another citation", async () => {
  // Twelve: each passage against two ways the other source states the claim's figure.
  const report = "# R\n\nIn 2024, Northwind's revenue was $4.3 billion [1][2].";
  for (const two of ["Northwind: $4.3 billion.", "Northwind reported revenue of $4.3 billion, analysts said."]) {
    for (const one of TITLE_CASE_RIVALS) {
      const [claim] = (await audit(report, [source(1, one), source(2, two)])).claims;
      const label = `${one} / ${two}: ${claim.status} ${JSON.stringify(claim.links.map((l) => [l.sourceIndex, l.stance, l.status, l.reasons.map((r) => r.code)]))}`;
      assert.notEqual(claim.status, "supported", label);
      assert.ok(!claim.links.some((l) => l.sourceIndex === 1 && l.status === "supported"), label);
      assert.ok(!claim.links.some((l) => l.reasons.some((r) => r.code === "stated_by_other_citation")), label);
    }
  }
});

test("a run of title-case words ending in a common noun, or opening a sentence unnamed elsewhere, names no subject", () => {
  const claim = "In 2024, Northwind's revenue was $4.3 billion.";
  const corroborating = ["Northwind's revenue was $4.3 billion in 2024."];
  for (const passage of [
    ...TITLE_CASE_RIVALS,
    "Net Revenue was $3.9 billion in 2024.",
    "GAAP Revenue was $3.9 billion in 2024.",
    "Its Revenue was $3.9 billion in 2024.",
    "The filing shows that Cloud Revenue was $3.9 billion in 2024.",
    "Company's revenue was $3.9 billion in 2024.",
  ]) {
    const result = auditEvidence({ claim, passage, corroborating });
    assert.ok(!result.reasons.some((r) => r.code === "stated_by_other_citation"), passage);
    assert.ok(result.ceiling < SUPPORTED_MIN, `${passage}: ${result.reasons.map((r) => r.code).join(", ")}`);
  }
});

test("a run of title-case words names a subject only on evidence beyond its capitals", () => {
  const claim = "Northwind earned $4.3 billion in 2024, while Southwind earned $2.1 billion.";
  const corroborating = ["Southwind earned $2.1 billion in 2024."];
  for (const passage of [
    // An organisation's suffix.
    "Northwind earned $4.3 billion in 2024. Contoso Labs earned $3.0 billion, a filing by Contoso showed.",
    "Northwind earned $4.3 billion in 2024, and Contoso Labs earned $3.0 billion.",
    "Northwind earned $4.3 billion in 2024, while Contoso Group earned $3.0 billion.",
    // A possessive owner.
    "Northwind earned $4.3 billion in 2024. Contoso's revenue was $3.0 billion.",
  ]) {
    const result = auditEvidence({ claim, passage, corroborating });
    assert.ok(result.reasons.some((r) => r.code === "stated_by_other_citation"), passage);
    assert.equal(result.ceiling, 1, `${passage}: ${result.reasons.map((r) => r.code).join(", ")}`);
  }
  // Title case alone, opening a sentence or not, named again or not: no stand-in, the figure is merely absent here.
  for (const passage of [
    "Northwind earned $4.3 billion in 2024. Contoso Robotics earned $3.0 billion.",
    "Northwind earned $4.3 billion in 2024, while Contoso Robotics earned $3.0 billion.",
    "Northwind earned $4.3 billion in 2024, while Contoso earned $3.0 billion.",
    "Northwind earned $4.3 billion in 2024, while Contoso Robotics earned $3.0 billion. Contoso Robotics is based in Ohio.",
  ]) {
    const unnamed = auditEvidence({ claim, passage, corroborating });
    assert.ok(!unnamed.reasons.some((r) => r.code === "stated_by_other_citation"), passage);
    assert.ok(unnamed.reasons.some((r) => r.code === "figure_absent"), passage);
  }
});

test("a word shared with another run is a family name only when the claim names that family", () => {
  // "Alpha Free" beside "Alpha Pro", for a claim about Alpha Pro: a sibling plan, and its figure is not the claim's.
  const sibling = auditEvidence({
    claim: "Alpha Pro includes 100 GB of storage, against 50 GB for Beta Plus.",
    passage: "Alpha Pro costs $20 per month and includes 100 GB of storage. Alpha Free includes 5 GB of storage.",
    corroborating: ["Beta Plus costs $15 per month and includes 50 GB of storage."],
  });
  assert.ok(sibling.reasons.some((r) => r.code === "stated_by_other_citation"), sibling.reasons.map((r) => r.code).join(", "));
  assert.equal(sibling.ceiling, 1);
  // Two capitalised measures sharing a word, a family the claim never names.
  const claim = "In 2024, Northwind's revenue was $4.3 billion.";
  const corroborating = ["Northwind's revenue was $4.3 billion in 2024."];
  for (const passage of [
    "On revenue, the group recorded Gross Receipts of $3.9 billion in 2024, and Gross Proceeds of $4.1 billion.",
    "On revenue in 2024, Top Line Growth was 9% and Top Line reached $3.9 billion.",
    "Gross Receipts rose 4% in 2024. On revenue, the group recorded Gross Receipts of $3.9 billion.",
  ]) {
    const result = auditEvidence({ claim, passage, corroborating });
    assert.ok(!result.reasons.some((r) => r.code === "stated_by_other_citation"), passage);
    assert.ok(result.ceiling < SUPPORTED_MIN, `${passage}: ${result.reasons.map((r) => r.code).join(", ")}`);
  }
});

/** The verifier's title-case measures (v1-corr6, v1-corr8): [claim, passage, the measure as written]. */
const TITLE_CASE_MEASURES: Array<[claim: string, passage: string, measure: string]> = [
  ["In 2024, Northwind's revenue was $4.3 billion [1][2].", "In 2024, the revenue line showed that Net Takings totalled $3.9 billion.", "Net Takings"],
  ["In 2024, Northwind's revenue was $4.3 billion [1][2].", "Revenue, 2024: the group recorded Gross Receipts of $3.9 billion, the report says.", "Gross Receipts"],
  ["In 2024, Northwind's revenue was $4.3 billion [1][2].", "On revenue, the 2024 results put Top Line at $3.9 billion.", "Top Line"],
  ["In 2024, Northwind's revenue was $4.3 billion [1][2].", "The revenue section of the 2024 report gives Total Billings as $3.9 billion.", "Total Billings"],
  ["In 2024, Northwind's revenue was $4.3 billion [1][2].", "Looking at revenue in 2024, Gross Proceeds amounted to $3.9 billion.", "Gross Proceeds"],
  ["In 2024, Northwind's capital spending was $4.3 billion [1][2].", "Capital spending in 2024: the company's Capital Expenditure came to $3.9 billion.", "Capital Expenditure"],
  ["In 2024, Northwind's profit was $4.3 billion [1][2].", "On profit, the 2024 accounts show a Bottom Line of $3.9 billion.", "Bottom Line"],
  ["In 2024, Northwind's research spending was $4.3 billion [1][2].", "Research spending rose in 2024, when R&D Outlays reached $3.9 billion.", "R&D Outlays"],
  ["In 2024, Northwind's insurance revenue was $4.3 billion [1][2].", "Insurance revenue for 2024: the insurer posted Gross Written Premiums of $3.9 billion.", "Gross Written Premiums"],
  ["In 2024, Northwind's revenue was $4.3 billion [1][2].", "In 2024, according to the revenue section of the filing, Core Billings were $3.9 billion.", "Core Billings"],
  ["In 2024, Northwind's revenue was $4.3 billion [1][2].", "For 2024, Revenue Bookings were $3.9 billion, and revenue rose.", "Revenue Bookings"],
];

test("a title-case measure giving a different figure is never shown as support through another citation, whatever its case", async () => {
  const judges: Record<string, CitationJudge> = {
    credulous,
    optimistic: async () => ({ verdict: "supported", strength: 0.8 }),
  };
  for (const [sentence, passage, measure] of TITLE_CASE_MEASURES) {
    for (const one of [passage, passage.replace(measure, measure.toLowerCase())]) {
      for (const [name, judge] of Object.entries(judges)) {
        const report = `# R\n\n${sentence}`;
        const outcome = await auditClaims({
          claims: selectClaimsForAudit(report, 40),
          sources: [source(1, one), source(2, "Northwind: $4.3 billion.")],
          judge,
          judgeCap: 100,
          asOf: ASOF,
        });
        const [claim] = outcome.claims;
        const label = `${name} | ${one}: ${claim.status} ${JSON.stringify(claim.links.map((l) => [l.sourceIndex, l.status, l.reasons.map((r) => r.code)]))}`;
        assert.notEqual(claim.status, "supported", label);
        assert.ok(!claim.links.some((l) => l.sourceIndex === 1 && l.status === "supported"), label);
        assert.ok(!claim.links.some((l) => l.reasons.some((r) => r.code === "stated_by_other_citation")), label);
        assert.notEqual(repairReportFromClaims(report, outcome.claims).report, report, label);
      }
    }
  }
});

// ── Polarity: another name for the subject beside a rival doing the opposite ──

/** From the verifier's battery (v1-battery): a subject, what it did, another name for it, the predicate both ways, rivals. */
const RIVAL_ROWS: Array<{ s: string; o: string; aliases: string[]; t: string; tNeg: string; rivals: string[] }> = [
  {
    s: "Contoso Air",
    o: "added flights to Lisbon",
    aliases: ["the airline", "the low-cost carrier", "the Dublin-based carrier"],
    t: "added flights to Porto",
    tNeg: "did not add flights to Porto",
    rivals: ["Ryanair", "its main competitor", "easyJet"],
  },
  {
    s: "The European Commission",
    o: "fined Google in 2024",
    aliases: ["the regulator", "the Brussels-based regulator", "the EU executive"],
    t: "fined Apple in 2024",
    tNeg: "did not fine Apple in 2024",
    rivals: ["Japan", "South Korea's competition watchdog", "the UK regulator"],
  },
  {
    s: "The new vaccine",
    o: "was approved for adults in 2021",
    aliases: ["the shot", "the two-dose shot, made by Contoso,", "the jab"],
    t: "was approved for children",
    tNeg: "was not approved for children",
    rivals: ["a rival vaccine", "the older vaccine", "an experimental shot"],
  },
  {
    s: "The Bank of England",
    o: "raised rates in May",
    aliases: ["the central bank", "the UK central bank", "Threadneedle Street"],
    t: "raised rates in August",
    tNeg: "did not raise rates in August",
    rivals: ["the Bank of Canada", "the European Central Bank", "the Fed"],
  },
];

const capitalised = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const RIVAL_FORMS: Array<(s: string, o: string, alias: string, said: string, rival: string, rivalSaid: string) => string> = [
  (s, o, a, t, r, rt) => `${s} ${o}. ${capitalised(a)} ${t}. ${capitalised(r)} ${rt}.`,
  (s, o, a, t, r, rt) => `${capitalised(r)} ${rt}. ${s} ${o}. ${capitalised(a)} ${t}.`,
  (s, o, a, t, r, rt) => `${s} ${o}. ${capitalised(a)} ${t}, while ${r} ${rt}.`,
  (s, o, a, t, r, rt) => `${s} ${o}, but ${a} ${t}. ${capitalised(r)} ${rt}.`,
  (s, o, a, t, r, rt) => `${s} ${o}. ${capitalised(a)} ${t}, officials said. ${capitalised(r)} ${rt}, according to filings.`,
];
/** The other name's predicate and the rival's, each with a word or two of its own: no longer an exact tie. */
const NEAR_TIES: Array<[aliasExtra: string, rivalExtra: string]> = [["", ""], [" either", ""], ["", " too"], [" at all", " as well"]];

test("another name for the subject denying (or affirming) what a rival does the opposite of leaves it to the judge", () => {
  const contradicted: string[] = [];
  for (const row of RIVAL_ROWS) {
    for (const alias of row.aliases) {
      for (const rival of row.rivals) {
        for (const [aliasExtra, rivalExtra] of NEAR_TIES) {
          for (const form of RIVAL_FORMS) {
            const denial = form(row.s, row.o, alias, row.tNeg + aliasExtra, rival, row.t + rivalExtra);
            if (polarity(`${row.s} ${row.tNeg}.`, denial)) contradicted.push(`${row.s} ${row.tNeg}. <> ${denial}`);
            const affirmation = form(row.s, row.o, alias, row.t + aliasExtra, rival, row.tNeg + rivalExtra);
            if (polarity(`${row.s} ${row.t}.`, affirmation)) contradicted.push(`${row.s} ${row.t}. <> ${affirmation}`);
          }
        }
      }
    }
  }
  assert.deepEqual(contradicted, []);
});

test("beside a rival, the flip of a claim whose source names the subject again or carries it on with a pronoun is still caught", () => {
  const missed: string[] = [];
  for (const row of RIVAL_ROWS) {
    for (const rival of row.rivals) {
      for (const same of ["it", row.s.replace(/^The /, "the ")]) {
        const denial = `${row.s} ${row.o}. ${capitalised(same)} ${row.tNeg}. ${capitalised(rival)} ${row.t}.`;
        if (!polarity(`${row.s} ${row.t}.`, denial)) missed.push(`${row.s} ${row.t}. <> ${denial}`);
        const affirmation = `${row.s} ${row.o}. ${capitalised(same)} ${row.t}, while ${rival} ${row.tNeg}.`;
        if (!polarity(`${row.s} ${row.tNeg}.`, affirmation)) missed.push(`${row.s} ${row.tNeg}. <> ${affirmation}`);
      }
    }
  }
  assert.deepEqual(missed, []);
});

test("the verifier's rival cases end to end: the judge is asked and the report is left as written", async () => {
  for (const [sentence, body] of [
    ["Contoso Air did not add flights to Porto", "Contoso Air added flights to Lisbon. The low-cost carrier did not add flights to Porto. Ryanair added flights to Porto."],
    ["The European Commission did not fine Apple in 2024", "The European Commission fined Google in 2024. The Brussels-based regulator did not fine Apple in 2024. Japan fined Apple in 2024."],
    ["The vaccine was not approved for children", "The vaccine was approved for adults in 2021. The shot was not approved for children. A rival vaccine was approved for children."],
    ["Tailspin Toys has not recalled its scooters", "Tailspin Toys recalled its toy drones. The Ohio-based manufacturer has not recalled its scooters. A competitor has recalled its scooters."],
  ]) {
    const report = `# R\n\n${sentence} [1].`;
    const outcome = await audit(report, [source(1, body!)]);
    const [claim] = outcome.claims;
    assert.equal(outcome.judgeCalls, 1, `${sentence}: the judge is asked, not pre-empted`);
    assert.equal(claim.status, "supported", `${sentence}: ${JSON.stringify(claim.links)}`);
    assert.equal(repairReportFromClaims(report, outcome.claims).report, report, sentence!);
  }
});

// ── Polarity: elided clauses ────────────────────────────────────────────────

test("an elided clause reads as the subject or the verb it leaves out", () => {
  const cases: Array<[claim: string, passage: string, contradicted: boolean]> = [
    // A subject left out ("but not suspended") and a verb left out ("but the dividend did not").
    ["The dividend was suspended in 2024.", "Profits fell in 2024. The dividend was cut, but not suspended.", true],
    ["The dividend was not suspended in 2024.", "Profits fell in 2024. The dividend was cut, but not suspended.", false],
    ["Revenue rose, profits rose, and the dividend rose.", "Revenue rose, profits rose, but the dividend did not.", true],
    ["Sales rose in 2024, and profits rose too.", "Sales rose in 2024, but profits did not.", true],
    ["Revenue rose, profits rose, but the dividend did not.", "Revenue rose, profits rose, but the dividend did not.", false],
    ["Revenue rose and profits rose, but the dividend did not rise.", "Revenue rose, profits rose, but the dividend did not.", false],
    // An elided affirmative agrees with the claim it answers, and denies its flip.
    ["The House passed the bill in 2024.", "The Senate did not pass the bill in 2024, but the House did.", false],
    ["The House did not pass the bill in 2024.", "The Senate did not pass the bill in 2024, but the House did.", true],
    ["The Senate did not pass the bill in 2024.", "The Senate did not pass the bill in 2024, but the House did.", false],
    ["Detroit raised its minimum wage in 2024.", "St. Louis did not raise its minimum wage in 2024, but Detroit did.", false],
    ["Beta raised prices in 2024.", "Alpha did not raise prices in 2024, but Beta did.", false],
    ["Beta did not raise prices in 2024.", "Alpha did not raise prices in 2024, but Beta did.", true],
    ["Alpha raised prices in 2024.", "Alpha did not raise prices in 2024, but Beta did.", true],
    ["Northwind raised prices.", "Northwind cut costs and did not raise prices.", true],
    ["Northwind cut costs and did not raise prices.", "Northwind cut costs and did not raise prices.", false],
  ];
  for (const [claim, passage, contradicted] of cases) {
    assert.equal(polarity(claim, passage), contradicted, `${claim} <> ${passage}`);
  }
});

test("a sentence with an elided clause, cited verbatim, is supported end to end and left as written", async () => {
  // The claim reaches the audit as "…but the House did ." once its marker is cut: the space must not hide the ellipsis.
  for (const sentence of [
    "The U.S. Senate did not pass the bill in 2024, but the House did",
    "Revenue was expected to rise in 2024, but did not",
    "Sales rose sharply in 2024, but profits did not",
    "The dividend was cut in 2024, but not suspended",
  ]) {
    for (const [pre, post] of [["", ""], ["Revenue was $4.3 billion in 2024. ", " It did not say why."]]) {
      const report = `# R\n\n${sentence} [1].`;
      const outcome = await audit(report, [source(1, `${pre}${sentence}.${post}`)]);
      const [claim] = outcome.claims;
      assert.equal(claim.status, "supported", `${sentence} | ${pre}|${post}: ${JSON.stringify(claim.links)}`);
      assert.ok(!claim.links.some((l) => l.reasons.some((r) => r.code === "polarity_mismatch")), sentence);
      assert.equal(repairReportFromClaims(report, outcome.claims).report, report, sentence);
    }
  }
});

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

test("a sentence-opening name still counts when the passage names it elsewhere; mid-sentence names are unchanged", () => {
  const claim = "Northwind earned $4.3 billion in 2024, while Southwind earned $2.1 billion.";
  const corroborating = ["Southwind earned $2.1 billion in 2024."];
  for (const passage of [
    "Northwind earned $4.3 billion in 2024. Contoso Labs earned $3.0 billion, a filing by Contoso showed.",
    "Northwind earned $4.3 billion in 2024, and Contoso Labs earned $3.0 billion.",
    "Northwind earned $4.3 billion in 2024. Contoso's revenue was $3.0 billion.",
  ]) {
    const result = auditEvidence({ claim, passage, corroborating });
    assert.ok(result.reasons.some((r) => r.code === "stated_by_other_citation"), passage);
    assert.equal(result.ceiling, 1, `${passage}: ${result.reasons.map((r) => r.code).join(", ")}`);
  }
  // Opening a sentence with nothing else naming it: no stand-in, the figure is merely absent here.
  const unnamed = auditEvidence({
    claim,
    passage: "Northwind earned $4.3 billion in 2024. Contoso Labs earned $3.0 billion.",
    corroborating,
  });
  assert.ok(!unnamed.reasons.some((r) => r.code === "stated_by_other_citation"));
  assert.ok(unnamed.reasons.some((r) => r.code === "figure_absent"));
});

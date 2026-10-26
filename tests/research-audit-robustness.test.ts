import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { auditEvidence, extractClaims, type CitationJudge } from "@/lib/research/claim-analysis";
import { readPropositions } from "@/lib/research/claim-polarity";
import { auditClaims, selectClaimsForAudit, type AuditSource } from "@/lib/research/citation-audit-core";
import { RESEARCH_CITATION_CASES } from "@/lib/eval/research-citation-cases";

/*
 * The audit never crashes (round 8). One sentence the polarity reader could
 * not parse — an inverted auxiliary, a determiner and "not": "Had the strike
 * not happened, …" — threw inside `readSubject`, and because the rival scan
 * audits every uncited passage of the corpus, that one sentence anywhere in
 * the research took `auditClaims` down for the whole report: every claim
 * unverified, the judge's spend lost, and in chat no audit at all.
 *
 * Three promises:
 *  - the shapes that threw parse, in a claim, a cited passage and an uncited
 *    one, and contradict nothing honest;
 *  - every sentence of the regression corpus, the eval set and a list of odd
 *    shapes goes through `auditEvidence` in either role without throwing;
 *  - whatever still throws inside one claim's checks leaves that claim
 *    unverified with the reason, and the rest of the report is audited.
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
    passages: body.split(/\n{2,}/).map((text, ordinal) => ({ text, locator: `chars:${ordinal}`, ordinal })),
  };
}

async function audit(report: string, sources: AuditSource[], judge: CitationJudge = credulous) {
  return auditClaims({ claims: selectClaimsForAudit(report, 40), sources, judge, judgeCap: 100, asOf: ASOF });
}

/** The forms that threw `Cannot read properties of undefined (reading 'low')` (probe-research-ns-1 crash2/crash3). */
const INVERTED_DETERMINER_FORMS = [
  "Had the strike not happened, Ferrolux would have produced 2.6 million tonnes of steel in 2023.",
  "Had a strike not happened, Ferrolux would have produced 2.6 million tonnes of steel in 2023.",
  "Had the plan worked, Ferrolux would have produced 2.6 million tonnes of steel in 2023.",
  "Were the strike not to happen, Ferrolux would produce 2.6 million tonnes of steel in 2023.",
  "Did the strike not cost Ferrolux 300,000 tonnes of steel in 2023?",
  "Should the strike not end, Ferrolux will produce 2.0 million tonnes of steel in 2024.",
  "Had the strike not happened.",
  "Nor did the board vote on the plan in 2023.",
  "Did the plan not work?",
  "Should the board not approve the deal, Ferrolux will close the plant in 2024.",
];

test("an inverted auxiliary before a determiner never throws, and a counterfactual contradicts nothing honest", () => {
  const honest = "Ferrolux produced 2.3 million tonnes of steel in 2023.";
  for (const passage of INVERTED_DETERMINER_FORMS) {
    for (const claim of [honest, "Ferrolux did not produce steel in 2023.", "The strike happened in 2023."]) {
      const result = auditEvidence({ claim, passage });
      if (claim === honest) assert.equal(result.contradicted, false, passage);
    }
    // In the claim's own place, too.
    auditEvidence({ claim: passage, passage: honest });
    assert.ok(Array.isArray(readPropositions(passage).props));
  }
});

test("the crashing forms in a cited passage, an uncited passage and the claim itself: the whole report is audited", async () => {
  for (const form of INVERTED_DETERMINER_FORMS) {
    // The counterfactual in an UNCITED source (the rival scan), beside a cited source and a second claim.
    const report = "# R\n\nFerrolux produced 2.3 million tonnes of steel in 2023 [1]. Tandor Rail carried 41 million passengers in 2024 [3].";
    const uncited = await audit(report, [
      source(1, "Ferrolux produced 2.3 million tonnes of steel in 2023, its annual report says."),
      source(2, `Steel output across the region was weak in 2023. ${form}`),
      source(3, "Tandor Rail carried 41 million passengers in 2024."),
    ]);
    assert.equal(uncited.claims.length, 2, form);
    assert.ok(uncited.claims.every((c) => c.status === "supported" && c.auditError === null), `${form}: ${JSON.stringify(uncited.claims.map((c) => c.status))}`);

    // In a cited passage, beside the supporting one.
    const cited = await audit("# R\n\nFerrolux produced 2.3 million tonnes of steel in 2023 [1][2].", [
      source(1, "Ferrolux produced 2.3 million tonnes of steel in 2023, its annual report says."),
      source(2, form),
    ]);
    assert.equal(cited.claims[0]!.status, "supported", form);
    assert.equal(cited.claims[0]!.auditError, null, form);
    assert.ok(!cited.claims[0]!.links.some((l) => l.status === "contradicted"), `${form}: ${JSON.stringify(cited.claims[0]!.links)}`);

    // As the claim.
    const asClaim = await audit(`# R\n\n${form.replace(/[.?]$/, "")} [1].`, [source(1, form)]);
    assert.ok(asClaim.claims.every((c) => c.auditError === null), form);
  }
});

/** Every string in the regression corpus's fixtures, cut into sentences: templates and axis values included. */
function corpusSentences(): string[] {
  const dir = join(__dirname, "fixtures", "research-claims");
  const strings = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === "string") strings.add(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  for (const file of ["pairs.json", "reports.json", "grids.json"]) walk(JSON.parse(readFileSync(join(dir, file), "utf8")));
  for (const c of RESEARCH_CITATION_CASES) {
    strings.add(c.report);
    for (const s of c.sources) strings.add(s.body);
    for (const e of c.expectations) strings.add(e.claim);
  }
  const sentences = new Set<string>();
  for (const text of strings) {
    for (const paragraph of text.split(/\n{2,}/)) {
      for (const sentence of paragraph.split(/(?<=[.!?])\s+(?=["'(\p{Lu}])/u)) {
        const trimmed = sentence.replace(/^#+\s*/, "").trim();
        if (trimmed) sentences.add(trimmed);
      }
    }
  }
  return [...sentences];
}

/** Shapes no corpus case has: empty, bare articles and negators, inversions, fragments, symbols, very long. */
const ODD_SHAPES = [
  "",
  " ",
  ".",
  "...",
  "?",
  "The.",
  "The",
  "A",
  "An.",
  "the the the.",
  "Had the.",
  "Had a.",
  "Did the?",
  "Were the?",
  "Should the.",
  "Nor did the.",
  "Not.",
  "No.",
  "Neither.",
  "Neither nor.",
  "Not the.",
  "Not only did the.",
  "It did not.",
  "They.",
  "It it it.",
  "Did it not raise prices?",
  "Has the board not met?",
  "Will the strike not end?",
  "Does the plan not work?",
  "Have the talks not failed?",
  "Are the strikes not over?",
  "Might the deal not close?",
  "Can the firm not pay?",
  "Would the plan not work, the firm would close.",
  "Had it not been for the strike, Ferrolux would have produced 2.6 million tonnes of steel in 2023.",
  "Were it not for subsidies, Ferrolux would have produced 1.9 million tonnes of steel in 2023.",
  "Had there not been a strike, Ferrolux would have produced 2.6 million tonnes of steel in 2023.",
  "Not the strike but the flood cut Ferrolux's output in 2023.",
  "Neither the strike nor the flood stopped Ferrolux producing steel in 2023.",
  "Did the strike not happen, Ferrolux asked.",
  "$",
  "%",
  "$4.3 billion",
  "4.3%",
  "2024",
  "In 2024.",
  "Q3 2024 FY2023 H1 2025.",
  "1 2 3 4 5.",
  "Revenue was $ billion.",
  "....$4.3bn....",
  "The 2.3 million.",
  "(The)",
  "\"The\"",
  "The, the, and the.",
  "— not —",
  "[1][2]",
  "\n\n\n",
  "Ünïcödé Ltd's revenue was €4,3 Mrd. in 2024.",
  "a a a a a a a a.",
  `${"The company ".repeat(120)}raised prices in 2024.`,
  `Northwind's revenue was ${Array.from({ length: 60 }, (_, i) => `$${i + 1}.${i % 10} billion in ${1980 + (i % 45)}`).join(", ")}.`,
];

test("fuzz: every corpus and eval sentence, and every odd shape, goes through auditEvidence in either role without throwing", () => {
  const sentences = [...corpusSentences(), ...ODD_SHAPES];
  assert.ok(sentences.length > 5_000, `${sentences.length} sentences`);
  const claims = [
    "Ferrolux produced 2.3 million tonnes of steel in 2023.",
    "Northwind did not raise prices in 2024.",
    "Northwind's revenue was $4.3 billion.",
  ];
  const passage = "Northwind's revenue was $4.3 billion in 2024, and it did not raise prices; Ferrolux produced 2.3 million tonnes of steel in 2023.";
  const threw: string[] = [];
  for (const sentence of sentences) {
    for (const input of [
      { claim: sentence, passage: sentence },
      { claim: sentence, passage },
      ...claims.map((claim) => ({ claim, passage: sentence })),
    ]) {
      try {
        auditEvidence(input);
      } catch (error) {
        threw.push(`${JSON.stringify(input)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      extractClaims(sentence);
    } catch (error) {
      threw.push(`extractClaims(${JSON.stringify(sentence)}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`fuzz: ${sentences.length} sentences, ${threw.length} threw`);
  assert.deepEqual(threw.slice(0, 20), []);
});

test("fuzz end to end: odd shapes as cited and uncited passages never take a report's audit down", async () => {
  const report =
    "# R\n\nFerrolux produced 2.3 million tonnes of steel in 2023 [1][2]. Northwind's revenue was $4.3 billion in 2024 [3]. Tandor Rail carried 41 million passengers in 2024 [4].";
  const outcome = await audit(report, [
    source(1, "Ferrolux produced 2.3 million tonnes of steel in 2023, its annual report says."),
    source(2, ODD_SHAPES.filter((s) => s.trim()).join("\n\n")),
    source(3, "Northwind's revenue was $4.3 billion in 2024."),
    source(4, "Tandor Rail carried 41 million passengers in 2024."),
    source(5, [...ODD_SHAPES, ...INVERTED_DETERMINER_FORMS].filter((s) => s.trim()).join("\n\n")),
  ]);
  assert.equal(outcome.claims.length, 3);
  assert.ok(outcome.claims.every((c) => c.auditError === null), JSON.stringify(outcome.claims.map((c) => c.auditError)));
  assert.ok(!outcome.claims.some((c) => c.status === "contradicted"), JSON.stringify(outcome.claims.map((c) => c.status)));
});

test("a claim whose checks throw is left unverified with the reason, and every other claim is audited", async () => {
  const report =
    "# R\n\nFerrolux produced 2.3 million tonnes of steel in 2023 [1]. Northwind's revenue was $4.3 billion in 2024 [2]. Tandor Rail carried 41 million passengers in 2024 [3].";
  // A judge that fails on one claim only: the stand-in for any error inside one claim's checks.
  const judge: CitationJudge = async ({ claim }) => {
    if (claim.includes("Northwind")) throw new Error("boom in one claim's checks");
    return { verdict: "supported", strength: 0.95 };
  };
  const outcome = await audit(
    report,
    [
      source(1, "Ferrolux produced 2.3 million tonnes of steel in 2023."),
      source(2, "Northwind's revenue was $4.3 billion in 2024."),
      source(3, "Tandor Rail carried 41 million passengers in 2024."),
    ],
    judge
  );
  const [ferrolux, northwind, tandor] = outcome.claims;
  assert.equal(outcome.claims.length, 3);
  assert.equal(ferrolux!.status, "supported");
  assert.equal(tandor!.status, "supported");
  assert.equal(northwind!.status, "unverified");
  assert.equal(northwind!.supportStrength, null);
  assert.deepEqual(northwind!.links, []);
  assert.equal(northwind!.contested, false);
  assert.match(northwind!.auditError ?? "", /could not check this claim \(boom in one claim's checks\)/);
  assert.equal(ferrolux!.auditError, null);
  assert.equal(outcome.counts.unverified, 1);
  assert.equal(outcome.counts.supported, 2);
});

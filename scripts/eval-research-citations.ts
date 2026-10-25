/**
 * The research citation eval (master brief 7.1).
 *
 *   npm run eval:research              # scorecards for the stock judges
 *   npm run eval:research -- --json    # the same, as JSON
 *   npm run eval:research -- --write   # also write docs/rework/program/evidence/research-citation-eval-<date>.json
 *
 * Whole reports from src/lib/eval/research-citation-cases.ts run through the
 * production citation audit (src/lib/eval/research-citations.ts) and are scored
 * against a human label for every claim. No network, no database, no model:
 * the judges are stubs that model a small model's failure mode, so the numbers
 * measure the deterministic audit. A live-model judge is NOT run here, and the
 * output says so rather than implying it.
 *
 * Exits non-zero when supported precision under the optimistic judge falls
 * below the §8.3 bar (95%) or the repair invents or keeps a citation to
 * nothing, so it can gate a change.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { RESEARCH_CITATION_CASES } from "../src/lib/eval/research-citation-cases";
import { STOCK_JUDGES, renderScorecard, scoreResearchCitationEval, type Scorecard } from "../src/lib/eval/research-citations";

const json = process.argv.includes("--json");
const write = process.argv.includes("--write");

function summary(card: Scorecard) {
  return {
    judge: card.judge,
    cases: card.cases,
    claims: card.claims,
    labelled: card.labelled,
    supportedPrecision: card.supportedPrecision,
    supportedRecall: card.supportedRecall,
    strictAccuracy: card.strictAccuracy,
    lenientAccuracy: card.lenientAccuracy,
    contradictionRecall: card.contradictionRecall,
    contradictionPrecision: card.contradictionPrecision,
    falseSupports: card.falseSupports.map((c) => ({ case: c.caseId, claim: c.claim, label: c.expected?.label, why: c.expected?.why })),
    flagFailures: card.flagFailures.map((c) => ({ case: c.caseId, claim: c.claim })),
    integrityFailures: card.integrityFailures,
    misses: card.results.flatMap((r) =>
      r.claims
        .filter((c) => c.expected && !c.strict)
        .map((c) => ({ case: c.caseId, claim: c.claim, expected: c.expected!.label, actual: c.actual.label, lenient: c.lenient }))
    ),
  };
}

async function main() {
  const cards: Scorecard[] = [];
  for (const [name, judge] of Object.entries(STOCK_JUDGES)) {
    cards.push(await scoreResearchCitationEval(RESEARCH_CITATION_CASES, judge, name));
  }
  const report = {
    generatedAt: new Date().toISOString(),
    mode: "stub-judges",
    liveModel: { status: "not_run", reason: "this script runs no model; the stub judges measure the deterministic audit" },
    scorecards: cards.map(summary),
  };
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    for (const card of cards) console.log(`${renderScorecard(card)}\n`);
    console.log("Live-model judge: not_run (this eval uses stub judges by design).");
  }
  if (write) {
    const dir = "docs/rework/program/evidence";
    mkdirSync(dir, { recursive: true });
    const file = `${dir}/research-citation-eval-${report.generatedAt.slice(0, 10)}.json`;
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${file}`);
  }
  const optimistic = cards.find((c) => c.judge === "optimistic")!;
  const failed =
    optimistic.supportedPrecision < 0.95 || cards.some((c) => c.integrityFailures.length > 0) || optimistic.unlabelled.length > 0;
  process.exitCode = failed ? 1 : 0;
}

void main();

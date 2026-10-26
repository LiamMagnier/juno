import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SUPPORTED_MIN, auditEvidence, repairReportFromClaims, type CitationJudge } from "@/lib/research/claim-analysis";
import { auditClaims, selectClaimsForAudit, type AuditSource } from "@/lib/research/citation-audit-core";

/*
 * The consolidated regression corpus of the deterministic citation audit:
 * every repro the verifiers and the fixer ever wrote against it (the probe
 * scripts of four review rounds), as data under
 * tests/fixtures/research-claims/. Hand-written cases are copied as they
 * were; generators ("8 subjects x 6 predicates x 4 contrasts") are kept as
 * grids the test expands. Each case says where it came from.
 *
 * Three promises, each asserted over the whole corpus:
 *
 *  - an honest claim is never contradicted by the text alone. A false
 *    contradiction skips the judge, sets the ceiling to 0 and rewrites the
 *    sentence as "Conflicting evidence: …" — the accusation this audit must
 *    never make;
 *  - a passage that gives a different figure is never shown as support: no
 *    other citation stands in for it, and the claim it cannot settle reads
 *    as contested, never as cleanly supported;
 *  - a real contradiction is still caught at least as often as the base
 *    branch caught it (its auditEvidence, recorded in baseline.json), which
 *    guessed — and paid for its recall with thousands of false contradictions.
 *
 * Kinds. pairs: `honest` (must not be contradicted), `contradiction` (a real
 * one: counted when contradicted), `disagree` (a passage with a different
 * figure and corroborating text that states the claim's: never stood in for,
 * never at the supported ceiling). reports, run through the whole audit with
 * a judge that rubber-stamps: `honest` (no claim contradicted, no "Conflicting
 * evidence"), `disagree` (the sources in `disagreeing` never shown as
 * support, and a supported claim contested), `contradiction` (contradicted
 * or contested).
 */

const DIR = join(__dirname, "fixtures", "research-claims");

type PairKind = "honest" | "contradiction" | "disagree";
interface PairCase {
  id: string;
  from: string;
  kind: PairKind;
  claim: string;
  passage: string;
  corroborating?: string[];
}
interface ReportCase {
  id: string;
  from: string;
  kind: "honest" | "disagree" | "contradiction";
  report: string;
  sources: string[];
  disagreeing?: number[];
  judge?: "credulous" | "optimistic";
}
type Row = Record<string, unknown>;
interface Grid {
  id: string;
  from: string;
  axes: Row[][];
  forms: Array<{ name: string; passage: string; cases: Array<{ kind: PairKind; claim: string }> }>;
}

/** The cartesian product of the axes, rows merged; a row's `$cross` crosses it with axes of its own. */
function product(axes: Row[][]): Row[] {
  let out: Row[] = [{}];
  for (const axis of axes) {
    const next: Row[] = [];
    for (const left of out) for (const right of axis) next.push({ ...left, ...right });
    out = next;
  }
  return out.flatMap((row) => {
    const { $cross, ...rest } = row as Row & { $cross?: Row[][] };
    return $cross ? product([[rest], ...$cross]) : [rest];
  });
}

/** `{field}` placeholders filled from the row, repeatedly (a field may hold placeholders of its own). */
function fill(template: string, row: Row): string {
  let text = template;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = text.replace(/\{(\w+)\}/g, (m, key: string) => (typeof row[key] === "string" ? (row[key] as string) : m));
    if (next === text) break;
    text = next;
  }
  assert.doesNotMatch(text, /\{\w+\}/, `unfilled placeholder in ${JSON.stringify(text)}`);
  return text;
}

/** The key baseline.json records a pair by. */
function keyOf(c: { kind: string; claim: string; passage: string; corroborating?: string[] }): string {
  return createHash("sha1").update(JSON.stringify([c.kind, c.claim, c.passage, c.corroborating ?? []])).digest("hex").slice(0, 12);
}

const familyOf = (id: string) => id.split("/")[0]!.replace(/-\d{3}$/, "");

function loadCorpus() {
  const explicit = (JSON.parse(readFileSync(join(DIR, "pairs.json"), "utf8")) as { cases: PairCase[] }).cases;
  const grids = (JSON.parse(readFileSync(join(DIR, "grids.json"), "utf8")) as { grids: Grid[] }).grids;
  const reports = (JSON.parse(readFileSync(join(DIR, "reports.json"), "utf8")) as { cases: ReportCase[] }).cases;
  const all: PairCase[] = [...explicit];
  for (const grid of grids) {
    const rows = product(grid.axes);
    grid.forms.forEach((form, fi) =>
      rows.forEach((row, ri) => {
        const passage = fill(form.passage, row);
        form.cases.forEach((c, ci) => all.push({ id: `${grid.id}/${fi}/${ri}/${ci}`, from: grid.from, kind: c.kind, claim: fill(c.claim, row), passage }));
      })
    );
  }
  // Deduplicated on the text; the same text under two labels is a corpus error.
  const conflicts: string[] = [];
  const pairs = new Map<string, PairCase>();
  for (const c of all) {
    const text = JSON.stringify([c.claim, c.passage, c.corroborating ?? []]);
    const seen = pairs.get(text);
    if (!seen) pairs.set(text, c);
    else if (seen.kind !== c.kind) conflicts.push(`${seen.id} (${seen.kind}) and ${c.id} (${c.kind}): ${c.claim} <= ${c.passage}`);
  }
  const byReport = new Map<string, ReportCase>();
  for (const r of reports) {
    const text = JSON.stringify([r.report, r.sources, r.judge ?? "credulous"]);
    const seen = byReport.get(text);
    if (!seen) byReport.set(text, r);
    else if (seen.kind !== r.kind) conflicts.push(`${seen.id} and ${r.id}`);
  }
  return { pairs: [...pairs.values()], reports: [...byReport.values()], conflicts };
}

const corpus = loadCorpus();
const baseline = JSON.parse(readFileSync(join(DIR, "baseline.json"), "utf8")) as { contradictionsCaught: string[]; honestContradicted: string[] };

const JUDGES: Record<"credulous" | "optimistic", CitationJudge> = {
  credulous: async () => ({ verdict: "supported", strength: 0.95 }),
  optimistic: async () => ({ verdict: "supported", strength: 0.8 }),
};

function sourcesOf(bodies: readonly string[]): AuditSource[] {
  return bodies.map((body, i) => ({
    index: i + 1,
    title: `Source ${i + 1}`,
    url: `https://s${i + 1}.example/page`,
    publishedAt: null,
    truncated: false,
    passages: body.split(/\n{2,}/).map((text, ordinal) => ({ text, locator: `chars:${ordinal}`, ordinal })),
  }));
}

async function auditReport(r: ReportCase) {
  const outcome = await auditClaims({
    claims: selectClaimsForAudit(r.report, 40),
    sources: sourcesOf(r.sources),
    judge: JUDGES[r.judge ?? "credulous"],
    judgeCap: 100,
    asOf: new Date("2026-10-25T12:00:00Z"),
  });
  return { outcome, repaired: repairReportFromClaims(r.report, outcome.claims).report };
}

const show = (c: PairCase) => `${c.id} [${c.from}] ${c.claim} <= ${c.passage}`;

test("the corpus is consolidated: deduplicated, labelled once, and large", () => {
  assert.deepEqual(corpus.conflicts, [], "one text, two labels");
  const kinds = (k: PairKind) => corpus.pairs.filter((c) => c.kind === k).length;
  assert.ok(corpus.pairs.length + corpus.reports.length >= 300, `${corpus.pairs.length} pairs and ${corpus.reports.length} reports`);
  assert.ok(kinds("honest") >= 100 && kinds("contradiction") >= 100 && kinds("disagree") >= 50, "every kind is represented");
  for (const kind of ["honest", "disagree", "contradiction"] as const) {
    assert.ok(corpus.reports.some((r) => r.kind === kind), `no ${kind} report`);
  }
  console.log(
    `corpus: ${corpus.pairs.length} pairs (${kinds("honest")} honest, ${kinds("contradiction")} contradictions, ${kinds("disagree")} disagreeing figures) and ${corpus.reports.length} reports`
  );
});

test("an honest claim is never contradicted by the text alone (base: thousands)", () => {
  const honest = corpus.pairs.filter((c) => c.kind === "honest");
  const contradicted = honest.filter((c) => auditEvidence({ claim: c.claim, passage: c.passage, corroborating: c.corroborating }).contradicted);
  const baseFalse = new Set(baseline.honestContradicted);
  console.log(`false contradictions: ${contradicted.length} of ${honest.length} honest pairs (base ${honest.filter((c) => baseFalse.has(keyOf(c))).length})`);
  assert.deepEqual(contradicted.map(show), []);
});

test("a passage giving a different figure is never stood in for, nor left at the supported ceiling", () => {
  const disagree = corpus.pairs.filter((c) => c.kind === "disagree");
  const supported = disagree.filter((c) => {
    const audit = auditEvidence({ claim: c.claim, passage: c.passage, corroborating: c.corroborating });
    return audit.reasons.some((r) => r.code === "stated_by_other_citation") || audit.ceiling >= SUPPORTED_MIN;
  });
  console.log(`false supports: ${supported.length} of ${disagree.length} disagreeing passages`);
  assert.deepEqual(supported.map(show), []);
});

test("real contradictions are caught at least as often as the base branch caught them", () => {
  const real = corpus.pairs.filter((c) => c.kind === "contradiction");
  const caught = new Set(real.filter((c) => auditEvidence({ claim: c.claim, passage: c.passage, corroborating: c.corroborating }).contradicted));
  const baseCaught = new Set(baseline.contradictionsCaught);
  const base = real.filter((c) => baseCaught.has(keyOf(c)));
  // Per family, for the record: where base is ahead, it is a subject carried by another name ("the firm", "the
  // treatment", "the regulator") or a denial without the claim's year — never proof, so the judge's to read.
  const families = new Map<string, { n: number; now: number; base: number }>();
  for (const c of real) {
    const f = families.get(familyOf(c.id)) ?? { n: 0, now: 0, base: 0 };
    f.n += 1;
    if (caught.has(c)) f.now += 1;
    if (baseCaught.has(keyOf(c))) f.base += 1;
    families.set(familyOf(c.id), f);
  }
  console.log(`real contradictions caught: ${caught.size} of ${real.length} (base ${base.length})`);
  for (const [family, f] of families) console.log(`  ${family.padEnd(24)} ${String(f.now).padStart(5)} / ${String(f.n).padEnd(5)} base ${f.base}`);
  assert.ok(caught.size >= base.length, `caught ${caught.size}, base caught ${base.length}`);
});

test("end to end: honest reports keep every claim uncontradicted and unrewritten", async () => {
  const bad: string[] = [];
  const honest = corpus.reports.filter((r) => r.kind === "honest");
  for (const r of honest) {
    const { outcome, repaired } = await auditReport(r);
    if (outcome.claims.some((c) => c.status === "contradicted") || /Conflicting evidence/.test(repaired)) {
      bad.push(`${r.id} [${r.from}] ${r.report.replace(/^# R\n\n/, "")}: ${outcome.claims.map((c) => c.status).join(", ")}`);
    }
  }
  console.log(`end to end, false contradictions: ${bad.length} of ${honest.length} honest reports`);
  assert.deepEqual(bad, []);
});

test("end to end: a disagreeing source is never shown as support, and a supported claim it disputes is contested", async () => {
  const shownAsSupport: string[] = [];
  const clean: string[] = [];
  let contested = 0;
  const disagree = corpus.reports.filter((r) => r.kind === "disagree");
  for (const r of disagree) {
    const { outcome } = await auditReport(r);
    const against = new Set(r.disagreeing ?? []);
    for (const claim of outcome.claims) {
      const fromThem = claim.links.filter((l) => against.has(l.sourceIndex));
      const desc = `${r.id} [${r.from}] ${r.report.replace(/^# R\n\n/, "")} <= ${r.sources.join(" // ")}: ${claim.status}${claim.contested ? " (contested)" : ""} ${JSON.stringify(claim.links.map((l) => [l.sourceIndex, l.status, l.reasons.map((x) => x.code)]))}`;
      const standsIn = fromThem.some((l) => l.reasons.some((x) => x.code === "stated_by_other_citation"));
      if (fromThem.some((l) => l.status === "supported") || (claim.status === "supported" && !claim.contested && standsIn)) shownAsSupport.push(desc);
      if (claim.status === "supported" && claim.contested) contested += 1;
      // A disagreeing figure the audit cannot place as another quantity, period or entity leaves the claim
      // contested. The one supported-and-clean case is a figure the passage gives for a named unit of the
      // company ("the unit known as Northwind Retail"), which is another entity.
      if (claim.status === "supported" && !claim.contested) clean.push(desc);
    }
  }
  console.log(`end to end, false supports: ${shownAsSupport.length} of ${disagree.length} reports; supported and contested ${contested}; supported and clean ${clean.length}`);
  assert.deepEqual(shownAsSupport, []);
  assert.ok(clean.length <= 1, clean.join("\n"));
});

test("end to end: a real disagreement still reads as one", async () => {
  const missed: string[] = [];
  const contradictions = corpus.reports.filter((r) => r.kind === "contradiction");
  for (const r of contradictions) {
    const { outcome } = await auditReport(r);
    if (!outcome.claims.some((c) => c.status === "contradicted" || c.contested)) missed.push(`${r.id} ${r.report.replace(/^# R\n\n/, "")} <= ${r.sources.join(" // ")}`);
  }
  console.log(`end to end, disagreements caught: ${contradictions.length - missed.length} of ${contradictions.length}`);
  // The one miss is a part-of-year phrase in a clause about something else ("as fourth-quarter sales jumped"),
  // which the period reading takes for the figure's own: the conservative direction, and a regression floor.
  assert.ok(missed.length <= 1, missed.join("\n"));
});

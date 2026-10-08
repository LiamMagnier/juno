import assert from "node:assert/strict";
import test from "node:test";

import {
  auditEvidence,
  claimsForAudit,
  extractClaims,
  parseAnswerSpan,
  repairReportFromClaims,
  selectPassagesForClaim,
  splitPassages,
  tableClaims,
  type ExtractedClaim,
} from "@/lib/research/claim-analysis";

/*
 * The citation audit reads table cells (protocol Stage 5's decision and
 * comparative matrices). Before, `extractClaims` skipped every `|` line, so
 * a matrix figure was only checked if the writer also repeated it in prose.
 */

const REPORT = [
  "# Copilot or Cursor",
  "<!-- juno:section=bottom-line -->",
  "## Executive verdict",
  "Cursor is the stronger agent; Copilot is cheaper per seat [1][2].",
  "",
  "<!-- juno:section=matrix -->",
  "## Comparative matrix",
  "| Dimension | GitHub Copilot [1] | Cursor [2] |",
  "| --- | --- | --- |",
  "| Business price per seat | $19 per user per month | $40 per user per month |",
  "| Premium requests | 300 per user per month [3] | 500 per month |",
  "| Annual discount | not published | 20% |",
  "",
  "| Plan | Price | Seats |",
  "|---|---|---|",
  "| Team [4] | $12 | 10 |",
  "",
  "<!-- juno:section=method -->",
  "## Methodology and source traceability",
  "We searched pricing pages.",
  "",
  "| Domain | Record | Date | Established | Citations |",
  "| --- | --- | --- | --- | --- |",
  "| cursor.com | pricing page | 2026-07-15 | Pro is $20 | [2] |",
].join("\n");

test("table cells become claims: column-header citations per option, cell citations win, the row label backs a row", () => {
  const claims = extractClaims(REPORT).filter((claim) => claim.form === "table");
  const texts = claims.map((claim) => `${claim.text} ${JSON.stringify(claim.citations)}`);
  assert.ok(texts.includes("Business price per seat — GitHub Copilot: $19 per user per month [1]"), texts.join("\n"));
  assert.ok(texts.includes("Business price per seat — Cursor: $40 per user per month [2]"));
  // A cell's own marker beats its column header's.
  assert.ok(texts.includes("Premium requests — GitHub Copilot: 300 per user per month [3]"));
  assert.ok(texts.includes("Premium requests — Cursor: 500 per month [2]"));
  // "not published" states nothing to check.
  assert.ok(!texts.some((text) => /not published/.test(text)));
  // One source for the row: one claim covering both cells.
  assert.ok(texts.includes("Team — Price: $12; Seats: 10 [4]"));
  // The methodology table attributes sources; it is not a claim.
  assert.ok(!texts.some((text) => /cursor\.com/.test(text)));
});

test("a table claim's span is its last cell, so the audit points at the cell and a repair keeps the table's shape", () => {
  const claims = extractClaims(REPORT);
  const cursorPrice = claims.find((claim) => claim.text === "Business price per seat — Cursor: $40 per user per month")!;
  const span = parseAnswerSpan(cursorPrice.answerSpan)!;
  assert.equal(REPORT.slice(span.start, span.end), "$40 per user per month");
  const repaired = repairReportFromClaims(REPORT, [
    { ...cursorPrice, status: "contradicted", supportStrength: 0.1 },
    { ...claims.find((claim) => claim.text.startsWith("Team — "))!, status: "unsupported", supportStrength: 0 },
  ]);
  assert.match(repaired.report, /^\| Business price per seat \| \$19 per user per month \| \$40 per user per month \(conflicting evidence\) \|$/m);
  assert.match(repaired.report, /^\| Team \[4\] \| \$12 \| 10 \(not established by the cited source\) \|$/m);
  // Prose and tables are in reading order.
  const starts = claims.map((claim) => parseAnswerSpan(claim.answerSpan)!.start);
  assert.deepEqual([...starts].sort((a, b) => a - b), starts);
});

test("an uncited figure in a table is still a claim (uncited), like an uncited figure in prose", () => {
  const claims = tableClaims([
    { text: "| Plan | Price |", start: 0 },
    { text: "| --- | --- |", start: 17 },
    { text: "| Pro | $20 |", start: 31 },
  ]);
  assert.equal(claims.length, 1);
  assert.equal(claims[0]!.text, "Pro — Price: $20");
  assert.deepEqual(claims[0]!.citations, []);
});

test("claimsForAudit keeps tables to a share of the cap so prose is still checked", () => {
  const claim = (text: string, start: number, form?: "table"): ExtractedClaim => ({ text, type: "fact", answerSpan: `${start}:${start + 1}`, citations: [1], ...(form ? { form } : {}) });
  const claims = [
    ...Array.from({ length: 30 }, (_, i) => claim(`table ${i}`, i, "table")),
    ...Array.from({ length: 30 }, (_, i) => claim(`prose ${i}`, 100 + i)),
  ];
  const kept = claimsForAudit(claims, 10);
  assert.equal(kept.length, 10);
  assert.equal(kept.filter((c) => c.form === "table").length, 4);
  assert.equal(kept.filter((c) => c.form !== "table").length, 6);
  // Few claims: everything.
  assert.equal(claimsForAudit(claims.slice(0, 5), 10).length, 5);
  // Only tables: tables fill the cap.
  assert.equal(claimsForAudit(claims.slice(0, 30), 10).length, 10);
});

test("a source page's long table is split into passages of whole rows, each with its header", () => {
  const rows = Array.from({ length: 40 }, (_, i) => `| Plan ${i} | $${i * 5} per seat | ${i * 10} GB |`);
  const body = ["Pricing overview for every plan.", "", "| Plan | Price | Storage |", "| --- | --- | --- |", ...rows].join("\n");
  const passages = splitPassages(body);
  assert.ok(passages.length >= 2);
  for (const passage of passages.filter((p) => p.text.includes("| Plan 3"))) {
    assert.match(passage.text, /\| Plan \| Price \| Storage \|\n\| --- \| --- \| --- \|/);
  }
  const claim = extractClaims(["| Plan | Price |", "| --- | --- |", "| Plan 37 | $185 per seat [1] |"].join("\n"))[0]!;
  const [best] = selectPassagesForClaim(claim, new Map([[1, passages]]));
  assert.match(best!.passage.text, /\| Plan 37 \| \$185 per seat \|/);
  const audit = auditEvidence({ claim: claim.text, claimType: claim.type, passage: best!.passage.text, publishedAt: null });
  assert.equal(audit.contradicted, false);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  bottomLineOf,
  citationOrder,
  isUsableReport,
  parseWriterOutput,
  renumberCitations,
  reportSections,
  stripModelSources,
  withoutMarkers,
} from "@/lib/research/report-structure";
import { serverOnlyIn } from "./fixtures/server-only-graph";

/*
 * The report's structure is read from its markers, never from its heading
 * text (SPEC §9.6.3, I-14): the headings are in the run's content language.
 */

const GERMAN = `<!-- juno:summary -->
Wärmepumpen arbeiten auch bei Frost zuverlässig [2], verlieren aber Leistung [1].
<!-- juno:report title="Wärmepumpen im kalten Klima" -->
# Wärmepumpen im kalten Klima
<!-- juno:section=bottom-line -->
## Fazit
Moderne Luft-Wasser-Wärmepumpen funktionieren weit unter null Grad [2].

<!-- juno:section=findings -->
## Wichtigste Ergebnisse
### Feldversuche
- Norwegische Feldversuche zeigen eine Jahresarbeitszahl über 2,5 [2].

<!-- juno:section=question:objective-1 -->
## Wie verhalten sich Wärmepumpen bei -20 °C?
Die Leistung sinkt [1][3].

<!-- juno:section=conflicts -->
## Wo sich die Quellen widersprechen
Hersteller und Feldversuche weichen ab [1][2].

<!-- juno:section=gaps -->
## Was sich nicht klären ließ
Langzeitdaten fehlen.

<!-- juno:section=method -->
## Methode
Drei Suchrunden.

## Quellen
[1] Herstellerdaten — https://example.com/data
[2] Feldversuch — https://example.no/trial
`;

test("report-structure.ts is client-safe", () => {
  assert.deepEqual(serverOnlyIn("src/lib/research/report-structure.ts"), []);
});

test("the writer's reply splits into summary, title and report by its markers", () => {
  const out = parseWriterOutput(GERMAN);
  assert.equal(out.title, "Wärmepumpen im kalten Klima");
  assert.match(out.summary, /^Wärmepumpen arbeiten auch bei Frost/);
  assert.ok(out.report.startsWith("# Wärmepumpen im kalten Klima"));
  assert.doesNotMatch(out.report, /juno:summary/);
});

test("sections are found by marker in any language", () => {
  const sections = reportSections(parseWriterOutput(GERMAN).report);
  assert.deepEqual(
    sections.map((s) => s.key),
    ["bottom-line", "findings", "question:objective-1", "conflicts", "gaps", "method"]
  );
  const question = sections.find((s) => s.kind === "question");
  assert.equal(question?.questionId, "objective-1");
  assert.equal(question?.heading, "Wie verhalten sich Wärmepumpen bei -20 °C?");
  // A ### inside a section stays part of it.
  const report = parseWriterOutput(GERMAN).report;
  const findings = sections.find((s) => s.key === "findings")!;
  assert.match(report.slice(findings.start, findings.end), /### Feldversuche/);
});

test("a model-written sources section is stripped in German too, and nothing marked ever is", () => {
  const report = parseWriterOutput(GERMAN).report;
  assert.doesNotMatch(report, /## Quellen/);
  assert.doesNotMatch(report, /example\.no\/trial/);
  assert.match(report, /## Methode/);

  // An unmarked sources list with a heading no list knows goes by its shape.
  const odd = "# T\n\n## Bottom\nText [1].\n\n## Ресурсы\n[1] A — https://a.example\n[2] B — https://b.example\n";
  assert.doesNotMatch(stripModelSources(odd), /Ресурсы/);
  // A marked section that happens to list links is kept.
  const marked = "# T\n\n<!-- juno:section=method -->\n## Method\nhttps://a.example\nhttps://b.example\n";
  assert.match(stripModelSources(marked), /## Method/);
  // Prose sections with an ordinary heading are kept.
  assert.match(stripModelSources("# T\n\n## Background\nPlain prose here.\nMore prose."), /## Background/);
});

test("a reply without markers is all report, titled by its first heading", () => {
  const out = parseWriterOutput("# A plain report\n\n## Bottom line\nIt works [1].");
  assert.equal(out.summary, "");
  assert.equal(out.title, "A plain report");
  assert.equal(bottomLineOf(out.report), "It works [1].");
});

test("a usable report is 400 characters with a ## heading (B6)", () => {
  assert.equal(isUsableReport(""), false);
  assert.equal(isUsableReport("## Heading\n" + "x".repeat(50)), false);
  assert.equal(isUsableReport("x".repeat(500)), false);
  assert.equal(isUsableReport("# T\n\n## Heading\n" + "word ".repeat(100)), true);
});

test("citation order is first appearance across summary then report, code excluded", () => {
  assert.deepEqual(citationOrder(["See [3] and [1].", "Then [1], [2] and `x`\n```\n[9]\n```\n[4]"]), [3, 1, 2, 4]);
});

test("renumbering maps known markers and leaves unknown ones visibly as they were", () => {
  const mapping = new Map([[3, 1], [1, 2]]);
  assert.equal(renumberCitations("A [3], B [1], C [7].\n```\n[3]\n```", mapping), "A [1], B [2], C [7].\n```\n[3]\n```");
});

test("markers are removed for a reader outside Juno", () => {
  assert.doesNotMatch(withoutMarkers(GERMAN), /<!--/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { exportFileName, exportFileSlug, reportMarkdownExport } from "@/lib/research/export";
import { serverOnlyIn } from "./fixtures/server-only-graph";

/*
 * SPEC §9.13: the Markdown export. The model's own sources list goes, `[n]`
 * stays, the appendix is built from the rows, and the file is named after
 * the report's title.
 */

const WRITTEN = new Date("2026-09-24T15:00:00.000Z");

const REPORT = `# Heat pumps in cold climates
<!-- juno:section=bottom-line -->
## Bottom line
Modern air-source heat pumps keep working well below freezing [1], though output falls [2].

<!-- juno:section=findings -->
## Key findings
- Field trials in Norway recorded seasonal efficiency above 2.5 [1].

## Sources
[1] Norwegian field trial — https://example.no/trial
[2] Manufacturer data — https://example.com/data
`;

test("export.ts is client-safe", () => {
  assert.deepEqual(serverOnlyIn("src/lib/research/export.ts"), []);
});

test("the slug is the title, NFKD with diacritics stripped, lowercase, dashes for the rest", () => {
  assert.equal(exportFileSlug("Pompes à chaleur : l'hiver nordique", WRITTEN), "pompes-a-chaleur-l-hiver-nordique");
  // ß has no decomposition, so NFKD keeps it and it becomes a dash like any other non-ASCII letter.
  assert.equal(exportFileSlug("  Ünïcödé — Straße 2026!  ", WRITTEN), "unicode-stra-e-2026");
  assert.equal(exportFileName("Heat pumps", WRITTEN), "heat-pumps.md");
});

test("a long title is cut to 80 characters on a word boundary", () => {
  const slug = exportFileSlug("word ".repeat(40), WRITTEN);
  assert.ok(slug.length <= 80, slug);
  assert.ok(!slug.endsWith("-"));
  assert.match(slug, /^word(-word)*$/);
});

test("a title with nothing left falls back to research-{date}", () => {
  assert.equal(exportFileSlug("", WRITTEN), "research-2026-09-24");
  assert.equal(exportFileSlug("熱ポンプ", WRITTEN), "research-2026-09-24");
});

test("the model's sources section is stripped and the appendix is built from rows", () => {
  const md = reportMarkdownExport({
    title: "Heat pumps in cold climates",
    report: REPORT,
    cited: [
      { title: "Norwegian field trial", url: "https://example.no/trial" },
      { title: "Manufacturer data", url: "https://example.com/data" },
    ],
    alsoRead: [{ title: "A blog post", url: "https://blog.example/post" }],
    writtenAt: WRITTEN,
    leadModel: "Claude Opus",
  });
  assert.match(md, /^---\ntitle: "Heat pumps in cold climates"\ndate: 2026-09-24\nlead_model: "Claude Opus"\n---\n/);
  // The model's list is gone: its entries appear once, in the appendix form.
  assert.equal(md.match(/https:\/\/example\.no\/trial/g)?.length, 1);
  assert.match(md, /## Sources\n\n\[1\] Norwegian field trial — https:\/\/example\.no\/trial \(accessed 2026-09-24\)\n\n\[2\] Manufacturer data/);
  assert.match(md, /### Also read\n\n- A blog post — https:\/\/blog\.example\/post/);
  // [n] kept in the prose, markers removed.
  assert.match(md, /below freezing \[1\], though output falls \[2\]/);
  assert.doesNotMatch(md, /juno:/);
});

test("a report with no cited sources has no empty appendix", () => {
  const md = reportMarkdownExport({ title: "T", report: "# T\n\n## Bottom line\nNothing found.", cited: [], writtenAt: WRITTEN });
  assert.doesNotMatch(md, /## Sources/);
  assert.doesNotMatch(md, /Also read/);
});

test("front matter survives quotes and newlines in the title", () => {
  const md = reportMarkdownExport({ title: 'The "best"\nheat pump', report: "# x", cited: [], writtenAt: WRITTEN });
  assert.match(md, /^---\ntitle: "The \\"best\\" heat pump"\n/);
});

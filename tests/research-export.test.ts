import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { exportFileName, exportFileSlug, reportMarkdownExport } from "@/lib/research/export";
import {
  reportArtifactIdentifier,
  researchExportInput,
  researchMarkdownFile,
  researchPlainMarkdown,
  researchWordFileName,
} from "@/components/research/report-export-model";
import { researchReportIdentifier } from "@/lib/research/completion-core";
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

// ── G37: the reader calls the exporter directly ──────────────────────────────

test("copy and Word take the same Markdown without front matter", () => {
  const md = reportMarkdownExport({
    title: "Heat pumps",
    report: REPORT,
    cited: [{ title: "Norwegian field trial", url: "https://example.no/trial" }],
    writtenAt: WRITTEN,
    frontMatter: false,
  });
  assert.doesNotMatch(md, /^---/);
  assert.match(md, /^# Heat pumps in cold climates\n/);
  assert.match(md, /## Sources\n\n\[1\] Norwegian field trial/);
});

test("a cited source keeps the number the report cites it by", () => {
  const md = reportMarkdownExport({
    title: "T",
    report: "# T\n\nOne [1] and four [4].",
    cited: [
      { title: "First", url: "https://a.example/1", number: 1 },
      { title: "Fourth", url: "https://a.example/4", number: 4 },
    ],
    writtenAt: WRITTEN,
  });
  assert.match(md, /\[1\] First — https:\/\/a\.example\/1/);
  assert.match(md, /\[4\] Fourth — https:\/\/a\.example\/4/);
  assert.doesNotMatch(md, /\[2\] Fourth/);
});

test("the reader's export input numbers the cited rows and names the file after the title", () => {
  const input = {
    run: {
      id: "run_1",
      report: null,
      finishedAt: WRITTEN.toISOString(),
      createdAt: "2026-09-24T14:00:00.000Z",
      leadModel: { id: "m", label: "Claude Opus" },
      conversationId: "c1",
      reportArtifactId: "a1",
    },
    model: {
      report: REPORT,
      sections: {
        cited: [
          { key: "cited:1", url: "https://example.no/trial", title: "Norwegian field trial", domain: "example.no", cited: 1 },
          { key: "cited:3", url: "https://example.com/data", title: "Manufacturer data", domain: "example.com", cited: 3 },
        ],
        read: [{ key: "r", url: "https://blog.example/post", title: "A blog post", domain: "blog.example" }],
        found: [{ key: "f", url: "https://unread.example", title: "Unread", domain: "unread.example" }],
      },
    },
    title: "Heat pumps in cold climates",
  };
  const lib = researchExportInput(input);
  assert.deepEqual(
    lib.cited.map((s) => s.number),
    [1, 3]
  );
  assert.equal(lib.leadModel, "Claude Opus");
  const file = researchMarkdownFile(input);
  assert.equal(file.fileName, "heat-pumps-in-cold-climates.md");
  assert.match(file.markdown, /^---\ntitle: "Heat pumps in cold climates"/);
  assert.match(file.markdown, /\[3\] Manufacturer data/);
  assert.match(file.markdown, /### Also read\n\n- A blog post/);
  // Found-but-unread sources are not part of the appendix.
  assert.doesNotMatch(file.markdown, /unread\.example/);
  assert.doesNotMatch(file.markdown, /juno:/);
  assert.doesNotMatch(researchPlainMarkdown(input), /^---/);
  assert.equal(researchWordFileName(input), "heat-pumps-in-cold-climates.docx");
  assert.equal(reportArtifactIdentifier("run_1"), "research-report-run_1");
});

test("the report artifact identifier matches the one completion writes", () => {
  assert.equal(reportArtifactIdentifier("abc"), researchReportIdentifier("abc"));
});

test("report-export.tsx no longer forks the format through an unprovided context", () => {
  const source = readFileSync("src/components/research/report-export.tsx", "utf8");
  assert.doesNotMatch(source, /createContext|fallbackMarkdownExport|research-\$\{date\}/);
  assert.match(source, /researchMarkdownFile/);
  // Word goes through the research export route; Share publishes the saved artifact.
  assert.match(source, /\/api\/research\/\$\{encodeURIComponent\(run\.id\)\}\/export/);
  assert.match(source, /<ShareDialog kind="ARTIFACT" artifactId=\{artifactId\}/);
});

test("the recap's Saved in Library is a link once the run knows the artifact", () => {
  const source = readFileSync("src/components/research/research-recap.tsx", "utf8");
  assert.match(source, /run\.reportArtifactId \? \(\s*<Link\s+href=\{artifactPath\(run\.reportArtifactId\)\}/);
});

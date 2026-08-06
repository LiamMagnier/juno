import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { Workbook } from "exceljs";
import {
  DeliverableError,
  GENERATED_DELIVERABLE_KINDS,
  bundleFiles,
  contentHashFor,
  deliverableRequestSchema,
  formatBytes,
  generateDeliverable,
  statusForDeliverableError,
  validateDeliverable,
  type DeliverableSpec,
  type DocumentSpec,
  type GeneratedDeliverable,
  type GeneratedDeliverableKind,
  type PresentationSpec,
  type ReportSpec,
  type SiteSpec,
  type SpreadsheetSpec,
} from "@/lib/work/deliverables";
import { buildSite } from "@/lib/work/deliverables/site";
import { ARTIFACT_EXTENSION, ARTIFACT_MAX_BYTES, ARTIFACT_MIME } from "@/lib/work/domain";

/*
 * Whether the files Juno hands people actually open.
 *
 * Every test here generates real bytes and then re-opens them with a reader
 * that had no part in writing them: JSZip walks the OOXML containers, exceljs
 * parses the workbook, a strict UTF-8 decoder reads the markdown. That is the
 * entire point of the exercise. A test that asserts a builder returned a
 * non-empty Buffer passes for a .docx with no `word/document.xml` in it — which
 * is exactly what a builder that threw half-way through produces, and exactly
 * what Word refuses to open. The Buffer proves nothing; the reader proves it.
 *
 * Four sections:
 *
 *   1. every kind generates, re-opens, and hashes to the bytes that were stored;
 *   2. what each format contains, checked against the spec that asked for it;
 *   3. escaping — a payload that would be script if anything let it through;
 *   4. the refusals: traversal, absolute and drive-letter entry names, a file
 *      past its ceiling, and a spec that never should have reached a builder.
 *
 * No database, no network, no object storage. `src/lib/work/deliverables` is
 * free of Prisma and of `server-only` precisely so this file can exist.
 */

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

/**
 * A payload that is script if any renderer treats authored text as markup.
 *
 * The quotes and the ampersand are part of it: the report and site renderers
 * interpolate strings into attribute values as well as into element bodies, and
 * an escaper that handles `<` but not `"` walks straight out of an attribute.
 */
const INJECTION = `<script>alert("xss & co")</script>`;

const DOCUMENT_SPEC: DocumentSpec = {
  kind: "document",
  title: "Q3 Supplier Review",
  subtitle: "Prepared for the operations team",
  blocks: [
    { type: "heading", level: 1, text: "Findings" },
    {
      type: "paragraph",
      text: [
        { text: "Unit cost fell " },
        { text: "12%", bold: true },
        { text: " against Q2, entirely on freight." },
      ],
    },
    {
      type: "list",
      ordered: true,
      items: ["Renegotiate the Rotterdam freight rate", "Consolidate the two overlapping lanes"],
    },
    {
      type: "table",
      caption: "Spend by supplier",
      header: ["Supplier", "Spend"],
      rows: [
        ["Meridian Freight", "48,200"],
        ["Halcyon Logistics", "31,900"],
      ],
    },
    { type: "quote", text: "The freight rate is the whole delta." },
    { type: "code", language: "sql", lines: ["select supplier, sum(spend)", "from invoices"] },
    { type: "pageBreak" },
    { type: "paragraph", text: "Appendix follows." },
  ],
};

const SPREADSHEET_SPEC: SpreadsheetSpec = {
  kind: "spreadsheet",
  title: "Q3 Spend",
  sheets: [
    {
      name: "Summary",
      columns: [
        { header: "Supplier", format: "text" },
        { header: "Spend", format: "currency" },
        { header: "Share", format: "percent" },
      ],
      rows: [
        ["Meridian Freight", 48200, 0.6],
        ["Halcyon Logistics", 31900, 0.4],
      ],
    },
    {
      name: "Notes",
      columns: [{ header: "Note" }, { header: "Reference" }],
      // A leading-zero identifier as a string, next to a genuine number. The
      // typed spec is what keeps "007" a reference and 48200 a quantity; there
      // is no inference step here to get it wrong.
      rows: [["Freight renegotiated in August.", "007"]],
    },
  ],
};

const PRESENTATION_SPEC: PresentationSpec = {
  kind: "presentation",
  title: "Q3 Supplier Review",
  slides: [
    { layout: "title", title: "Q3 Supplier Review", subtitle: "Operations", notes: "Thirty seconds." },
    { layout: "section", title: "Where the money went" },
    {
      layout: "bullets",
      title: "Findings",
      bullets: [{ text: "Freight is the whole delta" }, { text: "Two lanes overlap", level: 1 }],
    },
    { layout: "body", title: "Recommendation", paragraphs: ["Consolidate the Rotterdam lanes."] },
    {
      layout: "table",
      title: "Spend",
      header: ["Supplier", "Spend"],
      rows: [["Meridian Freight", "48,200"]],
    },
  ],
};

const REPORT_SPEC: ReportSpec = {
  kind: "report",
  title: "Q3 Supplier Review",
  subtitle: "Operations",
  summary: "Freight accounts for the entire quarter-over-quarter movement in unit cost.",
  blocks: [
    { type: "heading", level: 2, text: "Findings" },
    { type: "paragraph", text: "Unit cost fell 12% against Q2." },
    // Read off a supplier's web page by a run that had no way to know better.
    { type: "paragraph", text: INJECTION },
    {
      type: "table",
      header: ["Supplier", "Spend"],
      rows: [["Meridian Freight", "48,200"]],
    },
  ],
};

/** A 1x1 transparent PNG. Canonical base64, which `buildSite` insists on. */
const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const SITE_SPEC: SiteSpec = {
  kind: "site",
  title: "Q3 Supplier Review",
  description: "A read-only summary of the quarter.",
  theme: "cool",
  pages: [
    {
      path: "index.html",
      title: "Overview",
      summary: "Freight is the whole delta.",
      blocks: [
        { type: "paragraph", text: "Unit cost fell 12% against Q2." },
        { type: "paragraph", text: INJECTION },
      ],
    },
    {
      path: "notes/summary.html",
      title: "Notes",
      blocks: [{ type: "list", ordered: false, items: ["Renegotiated in August."] }],
    },
  ],
  assets: [{ path: "media/logo.png", contentType: "image/png", base64: PIXEL_PNG }],
};

/**
 * One spec per kind Juno can generate.
 *
 * Typed as a total record so a sixth generator cannot be added without a spec
 * appearing here, and asserted against the vocabulary below so it cannot be
 * added without this file failing until somebody proves the new kind opens.
 */
const SPECS: Record<GeneratedDeliverableKind, DeliverableSpec> = {
  document: DOCUMENT_SPEC,
  spreadsheet: SPREADSHEET_SPEC,
  presentation: PRESENTATION_SPEC,
  report: REPORT_SPEC,
  site: SITE_SPEC,
};

const PROVENANCE = [
  {
    kind: "web_page" as const,
    label: "Meridian Freight — rate card",
    url: "https://example.com/rates",
    retrievedAt: "2026-08-05T09:00:00.000Z",
  },
  { kind: "user_input" as const, label: "The goal named Q3 and Rotterdam." },
];

function generate(spec: DeliverableSpec): Promise<GeneratedDeliverable> {
  return generateDeliverable({ spec, provenance: PROVENANCE });
}

/** The bytes, re-opened as a zip container by a library that did not write them. */
function unzip(bytes: Buffer): Promise<JSZip> {
  return JSZip.loadAsync(bytes);
}

// ---------------------------------------------------------------------------
// 1. Every kind generates, re-opens and hashes to what was stored
// ---------------------------------------------------------------------------

test("every generatable kind has a spec in this file", () => {
  assert.deepEqual(Object.keys(SPECS).sort(), [...GENERATED_DELIVERABLE_KINDS].sort());
});

test("every kind generates bytes that a reader can re-open", async () => {
  for (const kind of GENERATED_DELIVERABLE_KINDS) {
    const generated = await generate(SPECS[kind]);

    assert.equal(generated.kind, kind);
    assert.ok(generated.byteSize > 0, `${kind} produced no bytes`);
    assert.equal(generated.byteSize, generated.bytes.byteLength);

    // The verdict is the file's, not the builder's: `validateDeliverable`
    // re-opened these exact bytes and said what it found in them.
    assert.equal(
      generated.validation.ok,
      true,
      `${kind} did not validate: ${generated.validation.problems.join(" ")}`
    );
    assert.equal(generated.validation.byteSize, generated.byteSize);
    assert.ok(generated.validation.observations.length > 0, `${kind} reported nothing it checked`);

    // The MIME and the extension come from `domain.ts` and nowhere else, which
    // is what stops a download from advertising one type and saving as another.
    assert.equal(generated.mimeType, ARTIFACT_MIME[kind]);
    assert.equal(generated.extension, ARTIFACT_EXTENSION[kind]);

    // The download route re-hashes the stored object and refuses on a mismatch,
    // so this hash has to be over exactly the bytes that get stored — computed
    // here independently of the module that produced it.
    const independent = createHash("sha256").update(generated.bytes).digest("hex");
    assert.equal(generated.contentHash, independent);
    assert.equal(contentHashFor(generated.bytes), independent);
  }
});

test("a second generation of the same spec re-validates the same way", async () => {
  // Nothing here asserts byte equality: the OOXML kinds embed a creation
  // timestamp, so two runs of the same spec are legitimately different files.
  // What must not change is the verdict.
  const first = await generate(SITE_SPEC);
  const second = await generate(SITE_SPEC);
  assert.equal(first.contentHash, second.contentHash, "a zip with fixed entry dates should be reproducible");

  const doc = await generate(DOCUMENT_SPEC);
  const docAgain = await generate(DOCUMENT_SPEC);
  assert.equal(doc.validation.ok, docAgain.validation.ok);
  assert.equal(doc.validation.details.paragraphCount, docAgain.validation.details.paragraphCount);
});

// ---------------------------------------------------------------------------
// 2. What each format actually contains
// ---------------------------------------------------------------------------

test("a document unzips to an OOXML package with a readable document part", async () => {
  const generated = await generate(DOCUMENT_SPEC);
  const zip = await unzip(generated.bytes);

  // The three parts whose absence makes a file that looks like a .docx to a
  // file manager and opens to an error in Word.
  assert.ok(zip.file("[Content_Types].xml"), "no [Content_Types].xml — not an OOXML package");
  assert.ok(zip.file("_rels/.rels"), "no package relationships");
  const main = zip.file("word/document.xml");
  assert.ok(main, "no word/document.xml — there is no document to read");

  const xml = await main.async("string");
  assert.match(xml, /<w:body/);
  for (const expected of [
    "Findings",
    "Meridian Freight",
    "Renegotiate the Rotterdam freight rate",
    "The freight rate is the whole delta.",
    "select supplier, sum(spend)",
  ]) {
    assert.ok(xml.includes(expected), `the document part is missing "${expected}"`);
  }

  // The subtitle is a separate paragraph, and the table header repeats on every
  // page the table spills onto — the property that makes a long table readable.
  assert.ok(xml.includes("Prepared for the operations team"));
  assert.match(xml, /<w:tblHeader/);

  assert.ok(
    (generated.validation.details.paragraphCount ?? 0) >= DOCUMENT_SPEC.blocks.length,
    "the validator counted fewer paragraphs than there are blocks"
  );
});

test("a spreadsheet opens and reports the sheets and cells that went in", async () => {
  const generated = await generate(SPREADSHEET_SPEC);

  // exceljs parses the whole workbook here, so a broken sheet relationship or a
  // corrupt sharedStrings fails exactly as it would in Excel.
  const workbook = new Workbook();
  await workbook.xlsx.load(generated.bytes as unknown as Parameters<Workbook["xlsx"]["load"]>[0]);

  assert.deepEqual(
    workbook.worksheets.map((sheet) => sheet.name),
    ["Summary", "Notes"]
  );
  assert.deepEqual(generated.validation.details.sheets, ["Summary", "Notes"]);
  // Header row plus the rows of the spec, per sheet.
  assert.deepEqual(generated.validation.details.rowCounts, [3, 2]);

  const summary = workbook.getWorksheet("Summary");
  assert.ok(summary, "the Summary sheet did not survive the round trip");
  assert.deepEqual(
    [1, 2, 3].map((column) => summary.getRow(1).getCell(column).value),
    ["Supplier", "Spend", "Share"]
  );
  assert.equal(summary.getRow(2).getCell(1).value, "Meridian Freight");

  // The one thing that matters in a spreadsheet: a figure is a number, not a
  // string that looks like one. A workbook of text sums to nothing, and nobody
  // finds out until they try to chart it.
  const spend = summary.getRow(2).getCell(2).value;
  assert.equal(typeof spend, "number", `spend came back as ${typeof spend}`);
  assert.equal(spend, 48200);
  assert.equal(summary.getRow(3).getCell(3).value, 0.4);

  const notes = workbook.getWorksheet("Notes");
  assert.ok(notes, "the Notes sheet did not survive the round trip");
  // And the other half of the same rule: an identifier with a leading zero is
  // still text, so "007" has not been corrupted into 7.
  assert.equal(notes.getRow(2).getCell(2).value, "007");
});

test("a presentation unzips to one slide part per slide in the spec", async () => {
  const generated = await generate(PRESENTATION_SPEC);
  const zip = await unzip(generated.bytes);

  assert.ok(zip.file("ppt/presentation.xml"), "no ppt/presentation.xml — not a presentation");
  const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  assert.equal(slides.length, PRESENTATION_SPEC.slides.length);
  assert.equal(generated.validation.details.slideCount, PRESENTATION_SPEC.slides.length);

  const first = zip.file(slides.sort()[0]);
  assert.ok(first);
  assert.match(await first.async("string"), /Q3 Supplier Review/);
});

test("a report renders markdown and a printable page from the same blocks", async () => {
  const generated = await generate(REPORT_SPEC);

  // The stored bytes of a report are the markdown, decoded strictly: a report
  // spliced at a multi-byte boundary must fail here rather than arrive as
  // replacement characters that look fine.
  const markdown = new TextDecoder("utf-8", { fatal: true }).decode(generated.bytes);
  assert.match(markdown, /^# Q3 Supplier Review/);
  assert.ok(markdown.includes("## Findings"));
  assert.ok(markdown.includes("Unit cost fell 12% against Q2."));
  assert.ok(markdown.includes("| Supplier | Spend |"));
  assert.ok(markdown.includes("Meridian Freight"));

  // Provenance is rendered into the file itself, not only into the row. A
  // report is a thing people forward, and a claim that arrives without its
  // sources is a claim nobody downstream can check.
  assert.ok(markdown.includes("## Sources"));
  assert.ok(markdown.includes("https://example.com/rates"));

  const html = generated.printableHtml;
  assert.ok(html, "a report has no printable page");
  assert.ok(html.includes("<h1>Q3 Supplier Review</h1>"));
  assert.ok(html.includes("Unit cost fell 12% against Q2."));
  assert.ok(html.includes("<th>Supplier</th>"));
  assert.ok(html.includes(`<a href="https://example.com/rates"`));
  // Self-contained: the stylesheet is inlined, because a linked one makes the
  // page render as unstyled text the moment the file leaves this machine.
  assert.ok(html.includes("<style>"));
  assert.doesNotMatch(html, /<link\b[^>]*stylesheet/i);

  assert.ok((generated.validation.details.headingCount ?? 0) >= 2);
});

test("a site bundles to the entry list its spec asked for", async () => {
  const generated = await generate(SITE_SPEC);
  const zip = await unzip(generated.bytes);

  const entries = Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(entries, ["index.html", "media/logo.png", "notes/summary.html", "styles.css"]);
  assert.deepEqual([...(generated.validation.details.entryNames ?? [])].sort(), entries);
  assert.equal(generated.validation.details.entryCount, 4);

  const index = zip.file("index.html");
  assert.ok(index);
  const page = await index.async("string");
  // The nav links every page, and the one stylesheet is the bundler's own.
  assert.ok(page.includes(`href="notes/summary.html"`));
  assert.ok(page.includes(`href="styles.css"`));
  // A nested page reaches the root stylesheet by going up, not by an absolute
  // path — a bundle is opened from a folder, not served from a document root.
  const nested = zip.file("notes/summary.html");
  assert.ok(nested);
  assert.ok((await nested.async("string")).includes(`href="../styles.css"`));

  const logo = zip.file("media/logo.png");
  assert.ok(logo);
  const bytes = await logo.async("nodebuffer");
  assert.ok(bytes.byteLength > 0, "the asset decoded to nothing");
  assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG");
});

// ---------------------------------------------------------------------------
// 3. Escaping
// ---------------------------------------------------------------------------

test("an authored script payload is text in every rendering", async () => {
  const report = await generate(REPORT_SPEC);
  const html = report.printableHtml;
  assert.ok(html);

  // The payload arrived in the spec as text and has to leave as text. A single
  // unescaped `<script` here is the whole difference between a report and an
  // XSS primitive with a Preview button on it.
  assert.doesNotMatch(html, /<script/i);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&quot;xss &amp; co&quot;"), "quotes or the ampersand went through raw");

  // The markdown is escaped too, and for a reason that is easy to miss: an
  // unescaped `<script>` in markdown is HTML the moment anything renders it.
  const markdown = report.bytes.toString("utf8");
  assert.ok(!markdown.includes("<script>"));
  assert.ok(markdown.includes("script"), "the payload text vanished instead of being escaped");

  const site = await generate(SITE_SPEC);
  const zip = await unzip(site.bytes);
  const index = zip.file("index.html");
  assert.ok(index);
  const page = await index.async("string");
  assert.doesNotMatch(page, /<script/i);
  assert.ok(page.includes("&lt;script&gt;"));

  // And the bundle validator agrees, having scanned the finished archive rather
  // than the code that wrote it.
  assert.equal(site.validation.ok, true, site.validation.problems.join(" "));
  assert.ok(
    site.validation.observations.some((line) => line.includes("No script")),
    "the site scan did not report on script, handlers or remote subresources"
  );
});

test("a citation that is not a web address is rendered inert rather than linked", async () => {
  // `z.string().url()` accepts `javascript:alert(1)` — it is a well-formed URL,
  // and the schema is not where this gets caught. The renderer is: only http(s)
  // becomes an anchor, and everything else is text. A run that read a hostile
  // page and cited it back is the whole reason that distinction exists.
  const generated = await generateDeliverable({
    spec: REPORT_SPEC,
    provenance: [{ kind: "web_page", label: "Rate card", url: "javascript:alert(1)" }],
  });

  const html = generated.printableHtml;
  assert.ok(html);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.doesNotMatch(html, /<a\b[^>]*javascript:/i);
  assert.ok(html.includes("Rate card"), "the citation was dropped instead of being made inert");

  // The markdown carries the address as plain text, which is right: it is what
  // the run read, and it is not a link in any renderer that reads this file.
  const markdown = generated.bytes.toString("utf8");
  assert.ok(markdown.includes("Rate card"));
  assert.ok(!markdown.includes("](javascript:"));
});

// ---------------------------------------------------------------------------
// 4. The refusals
// ---------------------------------------------------------------------------

async function refusal(run: () => Promise<unknown>): Promise<DeliverableError> {
  try {
    await run();
  } catch (err) {
    assert.ok(err instanceof DeliverableError, `threw ${String(err)} rather than a DeliverableError`);
    return err;
  }
  assert.fail("the call was not refused");
}

test("a bundle entry that would escape its directory is refused", async () => {
  // The canonical attack: a naive extractor writes this entry to exactly that
  // path relative to where it was unzipped, which is to say outside it.
  const traversal = await refusal(() =>
    bundleFiles([{ path: "../../.ssh/authorized_keys", content: "ssh-rsa AAAA" }])
  );
  assert.equal(traversal.code, "unsafe_path");
  assert.match(traversal.message, /escape the bundle directory/);
  assert.equal(statusForDeliverableError(traversal.code), 400);

  const absolute = await refusal(() => bundleFiles([{ path: "/etc/passwd", content: "root:x:0:0" }]));
  assert.equal(absolute.code, "unsafe_path");
  assert.match(absolute.message, /absolute/);

  // A drive letter is an absolute path on Windows and nothing at all on POSIX,
  // which is precisely why it cannot be left to the extractor to interpret.
  const drive = await refusal(() =>
    bundleFiles([{ path: "C:/Windows/System32/drivers/etc/hosts", content: "127.0.0.1" }])
  );
  assert.equal(drive.code, "unsafe_path");
  assert.match(drive.message, /drive letter/);

  // Backslashes are refused rather than normalised: the same name is traversal
  // to a Windows extractor and one oddly-named file to a POSIX one, and a rule
  // that depends on which machine opens the archive is not a rule.
  const backslash = await refusal(() =>
    bundleFiles([{ path: "..\\..\\evil.bat", content: "@echo off" }])
  );
  assert.equal(backslash.code, "unsafe_path");
  assert.match(backslash.message, /backslash/);

  // The same refusal reaches a site spec, which is where an agent would put one.
  const page = await refusal(() =>
    buildSite({
      ...SITE_SPEC,
      pages: [...SITE_SPEC.pages, { path: "../escape.html", title: "Escape", blocks: [{ type: "paragraph", text: "x" }] }],
    })
  );
  assert.equal(page.code, "unsafe_path");
});

test("a finished archive is judged by the names it stores, not the ones it reports", async () => {
  // Defence in depth, and a real distinction: JSZip resolves `..` out of entry
  // names as it loads, so `name` for an entry stored as `../evil.sh` reads back
  // as `evil.sh`. The stored name is what another extractor will act on, so the
  // validator has to judge that one — this is the test that says so.
  const hostile = new JSZip();
  hostile.file("index.html", "<!doctype html><title>ok</title>");
  hostile.file("../../evil.sh", "rm -rf /");
  const bytes = await hostile.generateAsync({ type: "nodebuffer" });

  const verdict = await validateDeliverable("site", bytes);
  assert.equal(verdict.ok, false);
  assert.ok(
    verdict.problems.some((problem) => problem.includes("Refused entry")),
    `the traversal entry was not refused: ${verdict.problems.join(" ")}`
  );
});

test("a deliverable past its ceiling is refused and the message names the cap", async () => {
  // 400 paragraphs at the per-run maximum: comfortably past the 5 MB a report
  // is allowed, and nothing about it is malformed. This is the honest case —
  // the spec is fine, the file is simply too big.
  const oversized: ReportSpec = {
    kind: "report",
    title: "Transcript",
    blocks: Array.from({ length: 400 }, () => ({ type: "paragraph" as const, text: "a".repeat(20_000) })),
  };

  const err = await refusal(() => generateDeliverable({ spec: oversized }));
  assert.equal(err.code, "too_large");
  assert.equal(statusForDeliverableError(err.code), 413);
  // The ceiling is quoted so the user knows what to reduce to, and nothing is
  // truncated: a report that stops halfway says nowhere that it is incomplete.
  assert.ok(
    err.message.includes(formatBytes(ARTIFACT_MAX_BYTES.report)),
    `the refusal does not name the cap: ${err.message}`
  );
  assert.match(err.message, /Nothing was truncated/);
});

/**
 * What the route does, in the order the route does it.
 *
 * The schema is the gate: a spec that fails it is refused before any builder
 * runs, so the result of this function has no bytes in it to inspect. That
 * absence is the assertion — an invalid spec must not cost CPU, an object in
 * storage, or a row.
 */
async function generateFromRaw(
  raw: unknown
): Promise<{ ok: false; code: "invalid_spec" } | { ok: true; deliverable: GeneratedDeliverable }> {
  const parsed = deliverableRequestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, code: "invalid_spec" };
  return { ok: true, deliverable: await generateDeliverable(parsed.data) };
}

test("a spec that fails its schema is refused before anything is built", async () => {
  const hostile: unknown[] = [
    // A kind with no generator behind it.
    { spec: { kind: "executable", title: "setup", base64: "TVqQ" } },
    // A document with nothing in it: `min(1)` on blocks exists because an empty
    // section produces a .docx Word declines to open.
    { spec: { kind: "document", title: "Empty", blocks: [] } },
    // A sheet name Excel reserves; the workbook would be refused at open time.
    {
      spec: {
        kind: "spreadsheet",
        title: "Q3",
        sheets: [{ name: "Q3/Q4", columns: [{ header: "A" }], rows: [] }],
      },
    },
    // A heading level that does not exist.
    {
      spec: {
        kind: "report",
        title: "Report",
        blocks: [{ type: "heading", level: 9, text: "Too deep" }],
      },
    },
    // A citation with no label: nothing a reader could check it against.
    { spec: REPORT_SPEC, provenance: [{ kind: "web_page", url: "https://example.com/rates" }] },
    // A source kind this build has no way to render honestly.
    { spec: REPORT_SPEC, provenance: [{ kind: "rumour", label: "Someone said so" }] },
    null,
  ];

  for (const raw of hostile) {
    const result = await generateFromRaw(raw);
    assert.equal(result.ok, false, `this was accepted: ${JSON.stringify(raw)?.slice(0, 80)}`);
    assert.equal(statusForDeliverableError("invalid_spec"), 400);
    assert.ok(!("deliverable" in result), "bytes were produced for a spec that failed its schema");
  }

  // And the request that is well-formed still gets through, so the refusals
  // above are about these specs rather than about the gate refusing everything.
  const accepted = await generateFromRaw({ spec: REPORT_SPEC, provenance: PROVENANCE });
  assert.equal(accepted.ok, true);
});

test("a spec the schema cannot catch is refused by the builder, not repaired", async () => {
  // Rectangular tables are a relationship between fields, which no per-field
  // schema can express. Padding the short row silently files its values under
  // the wrong headings, and a table of correct numbers under wrong headings is
  // worse than an error because it looks like data.
  const ragged: DocumentSpec = {
    kind: "document",
    title: "Ragged",
    blocks: [{ type: "table", header: ["Supplier", "Spend", "Share"], rows: [["Meridian", "48,200"]] }],
  };
  const err = await refusal(() => generateDeliverable({ spec: ragged }));
  assert.equal(err.code, "invalid_spec");
  assert.match(err.message, /Rows are not padded/);

  // The same rule in the spreadsheet builder, which is where it would do the
  // most damage.
  const shortRow: SpreadsheetSpec = {
    kind: "spreadsheet",
    title: "Q3",
    sheets: [{ name: "Summary", columns: [{ header: "A" }, { header: "B" }], rows: [[1]] }],
  };
  const sheetErr = await refusal(() => generateDeliverable({ spec: shortRow }));
  assert.equal(sheetErr.code, "invalid_spec");

  // Two sheets Excel considers the same name. Renaming one for the caller would
  // move data to a sheet they never asked for.
  const duplicate: SpreadsheetSpec = {
    kind: "spreadsheet",
    title: "Q3",
    sheets: [
      { name: "Summary", columns: [{ header: "A" }], rows: [] },
      { name: "summary", columns: [{ header: "A" }], rows: [] },
    ],
  };
  const duplicateErr = await refusal(() => generateDeliverable({ spec: duplicate }));
  assert.equal(duplicateErr.code, "invalid_spec");
});

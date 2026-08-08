import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";

import { extractDocument, selectExtractor } from "@/lib/knowledge/extract";
import { extractDocx } from "@/lib/knowledge/extract/docx";
import { extractPdf } from "@/lib/knowledge/extract/pdf";
import { extractPptx } from "@/lib/knowledge/extract/pptx";
import { extractTextDocument } from "@/lib/knowledge/extract/text";
import { extractXlsx } from "@/lib/knowledge/extract/xlsx";
import type { ExtractedBlock } from "@/lib/knowledge/extract/types";
import {
  checksumOf,
  planIngest,
  runIngest,
  type KnowledgeBlockInput,
  type KnowledgeDocumentRecord,
  type KnowledgeStore,
} from "@/lib/knowledge/ingest";

/*
 * Everything here is built in-process. There is no `tests/fixtures/*.docx`,
 * on purpose: a binary fixture checked into the repo is a file nobody can read
 * in a diff, and when a parser assertion fails a year from now the reader needs
 * to see exactly which XML produced it. The builders below are the fixtures.
 */

const utf8 = (text: string) => new TextEncoder().encode(text);

async function zipOf(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, body] of Object.entries(files)) zip.file(name, body);
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}

function blockAt(blocks: ExtractedBlock[], predicate: (b: ExtractedBlock) => boolean): ExtractedBlock {
  const found = blocks.find(predicate);
  assert.ok(found, `no block matched; got ${JSON.stringify(blocks.map((b) => b.text))}`);
  return found;
}

/* -------------------------------------------------------------------------- */
/* Extractor selection                                                         */
/* -------------------------------------------------------------------------- */

test("the extension decides, because uploads arrive as octet-stream", () => {
  // planAttachmentUpload stores every non-image under application/octet-stream
  // so it can never be served back inline. That is the real input shape here.
  assert.equal(selectExtractor("report.pdf", "application/octet-stream"), "pdf");
  assert.equal(selectExtractor("deck.pptx", "application/octet-stream"), "pptx");
  assert.equal(selectExtractor("model.xlsx", "application/octet-stream"), "xlsx");
  assert.equal(selectExtractor("notes.md", "application/octet-stream"), "text");
  assert.equal(selectExtractor("config.yaml", "application/octet-stream"), "text");
});

test("formats with no extractor are declined rather than failed", () => {
  // A null selection means no KnowledgeDocument is created at all. If images
  // produced `failed` documents, every screenshot a user uploads would show up
  // in their library as something that went wrong.
  assert.equal(selectExtractor("photo.png", "image/png"), null);
  assert.equal(selectExtractor("clip.mov", "video/quicktime"), null);
  assert.equal(selectExtractor("legacy.doc", "application/octet-stream"), null);
});

/* -------------------------------------------------------------------------- */
/* Text, markdown, JSON, YAML                                                  */
/* -------------------------------------------------------------------------- */

test("markdown blocks carry line ranges and a heading breadcrumb", () => {
  const source = [
    "# Handbook", // 1
    "", // 2
    "Welcome to the team.", // 3
    "", // 4
    "## Setup", // 5
    "", // 6
    "### Database", // 7
    "", // 8
    "Run the migrations before starting.", // 9
    "", // 10
    "- Install Postgres", // 11
    "- Create the role", // 12
    "", // 13
    "```sh", // 14
    "npm run db:push", // 15
    "```", // 16
    "", // 17
    "## Deploy", // 18
    "", // 19
    "Push to main.", // 20
  ].join("\n");

  const result = extractTextDocument({
    bytes: utf8(source),
    fileName: "handbook.md",
    mimeType: "application/octet-stream",
  });
  assert.equal(result.status, "ok");
  assert.equal(result.parser, "text");

  const prose = blockAt(result.blocks, (b) => b.text.startsWith("Run the migrations"));
  assert.deepEqual(prose.heading, ["Handbook", "Setup", "Database"]);
  assert.equal(prose.lineStart, 9);
  assert.equal(prose.lineEnd, 9);
  assert.equal(prose.path, "handbook.md");
  assert.equal(prose.confidence, 1);

  const item = blockAt(result.blocks, (b) => b.text === "Create the role");
  assert.equal(item.type, "list_item");
  assert.equal(item.lineStart, 12);

  const code = blockAt(result.blocks, (b) => b.text === "npm run db:push");
  assert.equal(code.type, "code");
  assert.equal(code.lineStart, 14);
  assert.equal(code.lineEnd, 16);

  // "## Deploy" must pop Setup › Database, not nest under them.
  const deploy = blockAt(result.blocks, (b) => b.text === "Push to main.");
  assert.deepEqual(deploy.heading, ["Handbook", "Deploy"]);
});

test("JSON members keep the source line numbers, not a re-serialized document's", () => {
  const source = ['{', '  "name": "juno",', '  "limits": {', '    "uploads": 10', '  }', '}'].join("\n");
  const result = extractTextDocument({
    bytes: utf8(source),
    fileName: "package.json",
    mimeType: "application/json",
  });
  assert.equal(result.status, "ok");

  const name = blockAt(result.blocks, (b) => b.text.includes('"name"'));
  assert.deepEqual(name.heading, ["name"]);
  assert.equal(name.lineStart, 2);

  const limits = blockAt(result.blocks, (b) => b.text.includes('"uploads"'));
  assert.deepEqual(limits.heading, ["limits"]);
  assert.equal(limits.lineStart, 3);
  assert.equal(limits.lineEnd, 5);
});

test("invalid JSON degrades with a reason and still indexes the readable lines", () => {
  const result = extractTextDocument({
    bytes: utf8('{\n  "name": "juno",\n}\n'),
    fileName: "broken.json",
    mimeType: "application/json",
  });
  assert.equal(result.status, "degraded");
  assert.match(result.reason ?? "", /not valid JSON/i);
  assert.ok(result.blocks.length > 0, "a trailing comma must not cost the whole file");
});

test("YAML sections are addressed by their top-level key", () => {
  const source = ["service: juno", "ports:", "  - 3000", "  - 3001", "env:", "  NODE_ENV: production"].join("\n");
  const result = extractTextDocument({ bytes: utf8(source), fileName: "compose.yml", mimeType: "text/yaml" });
  const ports = blockAt(result.blocks, (b) => b.text.includes("3001"));
  assert.deepEqual(ports.heading, ["ports"]);
  assert.equal(ports.lineStart, 2);
  assert.equal(ports.lineEnd, 4);
});

test("a binary file renamed to .txt is refused, not indexed as replacement characters", () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x10, 0x00, 0x42]);
  const result = extractTextDocument({ bytes, fileName: "photo.txt", mimeType: "text/plain" });
  assert.equal(result.status, "failed");
  assert.equal(result.blocks.length, 0);
  assert.match(result.reason ?? "", /binary/i);
});

/* -------------------------------------------------------------------------- */
/* DOCX                                                                        */
/* -------------------------------------------------------------------------- */

function docxOf(bodyXml: string): Promise<Uint8Array> {
  return zipOf({
    "[Content_Types].xml":
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels":
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`,
  });
}

const wp = (text: string, style?: string, list = false) =>
  `<w:p>${style || list ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${list ? "<w:numPr><w:ilvl w:val=\"0\"/><w:numId w:val=\"1\"/></w:numPr>" : ""}</w:pPr>` : ""}<w:r><w:t>${text}</w:t></w:r></w:p>`;

test("docx headings, list items and tables become blocks with breadcrumbs", async () => {
  const bytes = await docxOf(
    [
      wp("Quarterly Report", "Heading1"),
      wp("Revenue grew 12% against a flat market."),
      wp("Risks", "Heading2"),
      wp("Supply chain concentration", undefined, true),
      "<w:tbl><w:tr><w:tc>" +
        wp("Region") +
        "</w:tc><w:tc>" +
        wp("Total") +
        "</w:tc></w:tr><w:tr><w:tc>" +
        wp("EMEA") +
        "</w:tc><w:tc>" +
        wp("120") +
        "</w:tc></w:tr></w:tbl>",
      wp("Outlook", "Heading2"),
      wp("Steady."),
    ].join("")
  );

  const result = await extractDocx({ bytes, fileName: "q3.docx" });
  assert.equal(result.status, "ok");
  assert.equal(result.parser, "docx");

  const prose = blockAt(result.blocks, (b) => b.text.startsWith("Revenue grew"));
  assert.equal(prose.type, "paragraph");
  assert.deepEqual(prose.heading, ["Quarterly Report"]);
  assert.equal(prose.path, "word/document.xml");

  const item = blockAt(result.blocks, (b) => b.text === "Supply chain concentration");
  assert.equal(item.type, "list_item");
  assert.deepEqual(item.heading, ["Quarterly Report", "Risks"]);

  const table = blockAt(result.blocks, (b) => b.type === "table");
  assert.equal(table.text, "Region | Total\nEMEA | 120");
  assert.deepEqual(table.heading, ["Quarterly Report", "Risks"]);

  // A second Heading2 must replace the first, not stack under it.
  const outlook = blockAt(result.blocks, (b) => b.text === "Steady.");
  assert.deepEqual(outlook.heading, ["Quarterly Report", "Outlook"]);

  // No page numbers are claimed: this document was never laid out by Word.
  assert.equal(result.pageCount, undefined);
  assert.ok(result.blocks.every((b) => b.page === undefined));
});

test("docx page numbers appear only when Word recorded where the pages fell", async () => {
  const bytes = await docxOf(
    [
      wp("First page body"),
      '<w:p><w:r><w:lastRenderedPageBreak/><w:t>Second page body</w:t></w:r></w:p>',
    ].join("")
  );
  const result = await extractDocx({ bytes, fileName: "paged.docx" });
  assert.equal(blockAt(result.blocks, (b) => b.text === "First page body").page, 1);
  assert.equal(blockAt(result.blocks, (b) => b.text === "Second page body").page, 2);
  assert.equal(result.pageCount, 2);
});

test("an unparseable .docx degrades with a readable reason instead of throwing", async () => {
  const garbage = new Uint8Array(512).fill(0x41);
  const result = await extractDocx({ bytes: garbage, fileName: "not-really.docx" });
  assert.equal(result.status, "failed");
  assert.equal(result.blocks.length, 0);
  assert.match(result.reason ?? "", /not a valid Office document/i);
});

test("a password-protected Office file says so, rather than 'corrupted zip'", async () => {
  // OLE compound file magic — what Word writes when a document is encrypted.
  const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
  const result = await extractDocx({ bytes: ole, fileName: "secret.docx" });
  assert.equal(result.status, "failed");
  assert.match(result.reason ?? "", /password-protected/i);
});

/* -------------------------------------------------------------------------- */
/* PPTX                                                                        */
/* -------------------------------------------------------------------------- */

const shape = (text: string, placeholder?: string, box?: [number, number, number, number]) =>
  `<p:sp><p:nvSpPr><p:nvPr>${placeholder ? `<p:ph type="${placeholder}"/>` : ""}</p:nvPr></p:nvSpPr>` +
  (box
    ? `<p:spPr><a:xfrm><a:off x="${box[0]}" y="${box[1]}"/><a:ext cx="${box[2]}" cy="${box[3]}"/></a:xfrm></p:spPr>`
    : "") +
  `<p:txBody>${text
    .split("\n")
    .map((line) => `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`)
    .join("")}</p:txBody></p:sp>`;

const slideXml = (shapes: string) =>
  `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`;

test("pptx blocks carry the presentation-order slide number, title and notes", async () => {
  // slide2.xml is shown FIRST. This is the reordered-deck case: numbering the
  // slides by file name would cite every one of them wrongly.
  const bytes = await zipOf({
    "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    "ppt/presentation.xml":
      '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rIdB"/><p:sldId id="257" r:id="rIdA"/></p:sldIdLst></p:presentation>',
    "ppt/_rels/presentation.xml.rels":
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdA" Target="slides/slide1.xml"/><Relationship Id="rIdB" Target="slides/slide2.xml"/></Relationships>',
    "ppt/slides/slide1.xml": slideXml(shape("Appendix", "title") + shape("Methodology notes")),
    "ppt/slides/slide2.xml": slideXml(
      shape("Fourth Quarter", "title") +
        shape("Revenue up 12%\nChurn flat", undefined, [914400, 1828800, 5486400, 2743200]) +
        shape("7", "sldNum")
    ),
    "ppt/slides/_rels/slide2.xml.rels":
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="../notesSlides/notesSlide2.xml"/></Relationships>',
    "ppt/notesSlides/notesSlide2.xml": slideXml(shape("Do not read the numbers aloud.", "body")),
  });

  const result = await extractPptx({ bytes, fileName: "deck.pptx" });
  assert.equal(result.status, "ok");
  assert.equal(result.pageCount, 2);

  const title = blockAt(result.blocks, (b) => b.type === "slide_title" && b.text === "Fourth Quarter");
  assert.equal(title.slide, 1, "slide2.xml is the first slide in presentation order");

  const body = blockAt(result.blocks, (b) => b.text.includes("Churn flat"));
  assert.equal(body.slide, 1);
  assert.deepEqual(body.heading, ["Fourth Quarter"]);
  // Bullets from one text box stay in one block — a lone bullet is unreadable.
  assert.equal(body.text, "Revenue up 12%\nChurn flat");
  // 914400 EMU = 72 pt.
  assert.deepEqual(body.bbox, [72, 144, 432, 216]);

  const notes = blockAt(result.blocks, (b) => b.type === "speaker_notes");
  assert.equal(notes.slide, 1);
  assert.equal(notes.text, "Do not read the numbers aloud.");
  assert.deepEqual(notes.heading, ["Fourth Quarter"]);

  const appendix = blockAt(result.blocks, (b) => b.text === "Appendix");
  assert.equal(appendix.slide, 2);

  // The slide-number placeholder must not become a block whose text is "7".
  assert.ok(!result.blocks.some((b) => b.text === "7"));
});

test("a deck with no placeholders still gets a title, because generators omit them", async () => {
  // pptxgenjs — which this repo uses to generate decks — writes shapes with an
  // empty <p:nvPr/> and no <p:ph>. Without the fallback, a deck Juno produced
  // and the user re-uploaded would have no titles and no breadcrumbs at all.
  const bytes = await zipOf({
    "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    "ppt/slides/slide1.xml": slideXml(shape("Fourth Quarter") + shape("Revenue up 12%\nChurn flat")),
  });

  const result = await extractPptx({ bytes, fileName: "generated.pptx" });
  const title = blockAt(result.blocks, (b) => b.type === "slide_title");
  assert.equal(title.text, "Fourth Quarter");
  assert.deepEqual(blockAt(result.blocks, (b) => b.text.includes("Churn")).heading, ["Fourth Quarter"]);
});

test("a slide opening with a paragraph of prose is not given a fake title", async () => {
  const bytes = await zipOf({
    "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    "ppt/slides/slide1.xml": slideXml(
      shape("Revenue up 12%\nChurn flat") + shape("Second box")
    ),
  });
  const result = await extractPptx({ bytes, fileName: "prose.pptx" });
  assert.ok(!result.blocks.some((b) => b.type === "slide_title"), "two paragraphs is not a title");
  assert.deepEqual(result.blocks[0].heading, []);
});

/* -------------------------------------------------------------------------- */
/* XLSX                                                                        */
/* -------------------------------------------------------------------------- */

test("xlsx rows carry sheet + cell range, and formulas are indexed separately", async () => {
  const bytes = await zipOf({
    "[Content_Types].xml":
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
    "_rels/.rels":
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml":
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Revenue" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
    "xl/sharedStrings.xml":
      '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2"><si><t>Quarter</t></si><si><t>Total</t></si></sst>',
    "xl/worksheets/sheet1.xml":
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>17</v></c><c r="B2"><f>A2*2</f><v>34</v></c></row></sheetData></worksheet>',
  });

  const result = await extractXlsx({ bytes, fileName: "model.xlsx" });
  assert.equal(result.status, "ok");
  assert.equal(result.parser, "xlsx");
  assert.equal(result.pageCount, 1);

  const header = blockAt(result.blocks, (b) => b.type === "table" && b.cellRange === "A1:B1");
  assert.equal(header.sheet, "Revenue");
  assert.equal(header.text, "Quarter | Total");
  assert.deepEqual(header.heading, ["Revenue"]);

  // The data row is labelled by its headers, because a retrieved row arrives
  // without the header row above it.
  const row = blockAt(result.blocks, (b) => b.type === "table" && b.cellRange === "A2:B2");
  assert.equal(row.text, "Quarter: 17 | Total: 34");

  const formula = blockAt(result.blocks, (b) => b.type === "table_cell");
  assert.equal(formula.cellRange, "B2");
  assert.equal(formula.sheet, "Revenue");
  assert.equal(formula.text, "B2 = A2*2 → 34");
});

/* -------------------------------------------------------------------------- */
/* PDF                                                                         */
/* -------------------------------------------------------------------------- */

/** A minimal, uncompressed PDF, assembled byte by byte so /Length is truthful. */
function pdfOf(pageStreams: string[]): Uint8Array {
  const kids = pageStreams.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  const parts: string[] = [
    "%PDF-1.4\n",
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageStreams.length} >>\nendobj\n`,
  ];
  pageStreams.forEach((content, i) => {
    const pageNum = 3 + i * 2;
    const contentNum = pageNum + 1;
    parts.push(
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNum} 0 R /Resources << /Font << /F1 99 0 R >> >> >>\nendobj\n`
    );
    parts.push(
      `${contentNum} 0 obj\n<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream\nendobj\n`
    );
  });
  parts.push("99 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");
  parts.push("trailer\n<< /Size 100 /Root 1 0 R >>\n%%EOF\n");
  return new Uint8Array(Buffer.from(parts.join(""), "latin1"));
}

test("pdf text is grouped into paragraphs and stamped with its page number", () => {
  const bytes = pdfOf([
    "BT /F1 12 Tf 72 720 Td (Structured extraction) Tj 0 -14 Td (turns files into blocks.) Tj ET",
    "BT /F1 12 Tf 72 700 Td [(Every) -300 (block) -300 (carries) -300 (a) -300 (locator.)] TJ ET",
  ]);

  const result = extractPdf({ bytes, fileName: "program.pdf" });
  assert.equal(result.status, "ok", result.reason);
  assert.equal(result.parser, "pdf");
  assert.equal(result.pageCount, 2);

  const first = blockAt(result.blocks, (b) => b.text.startsWith("Structured extraction"));
  assert.equal(first.page, 1);
  assert.equal(first.path, "program.pdf");
  assert.equal(first.confidence, 1);
  // Two show operators 14pt apart are one paragraph, not two blocks.
  assert.equal(first.text, "Structured extraction turns files into blocks.");
  assert.ok(first.bbox && first.bbox.length === 4, "a measured bbox, not an invented one");
  assert.equal(first.bbox?.[0], 72);

  // TJ kerning below -120 thousandths of an em is a word space.
  const second = blockAt(result.blocks, (b) => b.page === 2);
  assert.equal(second.text, "Every block carries a locator.");
});

test("pdf paragraph breaks follow the vertical gaps on the page", () => {
  const bytes = pdfOf([
    "BT /F1 12 Tf 72 720 Td (First line of one.) Tj 0 -14 Td (Second line of one.) Tj 0 -60 Td (A separate paragraph.) Tj ET",
  ]);
  const result = extractPdf({ bytes, fileName: "gaps.pdf" });
  const texts = result.blocks.map((b) => b.text);
  assert.deepEqual(texts, ["First line of one. Second line of one.", "A separate paragraph."]);
});

test("a scanned pdf degrades with an honest reason instead of looking indexed", () => {
  // A page that only paints an image: no BT, no show operators. This is exactly
  // what a scan-to-PDF produces, and reporting it as an empty success would be
  // the worst outcome — the document would sit in the library looking ready.
  const bytes = pdfOf(["q 612 0 0 792 0 0 cm /Im1 Do Q"]);
  const result = extractPdf({ bytes, fileName: "scan.pdf" });
  assert.equal(result.status, "degraded");
  assert.equal(result.blocks.length, 0);
  assert.match(result.reason ?? "", /scan|no text layer/i);
  assert.equal(result.pageCount, 1);
});

test("a pdf with one scanned page among readable ones keeps the readable ones", () => {
  const bytes = pdfOf([
    "BT /F1 12 Tf 72 720 Td (Readable page.) Tj ET",
    "q 612 0 0 792 0 0 cm /Im1 Do Q",
  ]);
  const result = extractPdf({ bytes, fileName: "mixed.pdf" });
  assert.equal(result.status, "degraded");
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].page, 1);
  assert.match(result.reason ?? "", /1 of 2 pages/);
});

test("a password-protected pdf is reported, not attempted", () => {
  const bytes = new Uint8Array(
    Buffer.from("%PDF-1.6\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Encrypt 9 0 R /Root 1 0 R >>\n%%EOF", "latin1")
  );
  const result = extractPdf({ bytes, fileName: "locked.pdf" });
  assert.equal(result.status, "failed");
  assert.match(result.reason ?? "", /password-protected/i);
});

test("a non-pdf with a .pdf name fails with a reason rather than throwing", () => {
  const result = extractPdf({ bytes: utf8("just some text, honestly"), fileName: "fake.pdf" });
  assert.equal(result.status, "failed");
  assert.match(result.reason ?? "", /not a PDF/i);
});

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                    */
/* -------------------------------------------------------------------------- */

test("extractDocument never throws, whatever bytes it is handed", async () => {
  const hostile: Array<[string, Uint8Array]> = [
    ["a.pdf", new Uint8Array(0)],
    ["b.docx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xff, 0xff])],
    ["c.xlsx", new Uint8Array([0x50, 0x4b, 0x03, 0x04])],
    ["d.pptx", utf8("PK not really")],
    ["e.md", new Uint8Array([0, 0, 0, 0])],
  ];
  for (const [fileName, bytes] of hostile) {
    const result = await extractDocument({ bytes, fileName, mimeType: "application/octet-stream" });
    assert.ok(result, `${fileName} should have been claimed by an extractor`);
    assert.notEqual(result.status, "ok", `${fileName} must not claim success`);
    assert.ok((result.reason ?? "").length > 10, `${fileName} needs a reason a person can read`);
  }
});

test("unindexable formats return null so no document row is created", async () => {
  assert.equal(
    await extractDocument({ bytes: utf8("x"), fileName: "photo.png", mimeType: "image/png" }),
    null
  );
});

/* -------------------------------------------------------------------------- */
/* Ingest state machine                                                        */
/* -------------------------------------------------------------------------- */

const existing = (over: Partial<KnowledgeDocumentRecord> = {}): KnowledgeDocumentRecord => ({
  id: "doc_1",
  state: "ready",
  version: 1,
  parser: "text",
  parserVersion: "1",
  ...over,
});

test("identical bytes are not re-indexed", () => {
  const plan = planIngest({ existing: existing(), parser: "text", parserVersion: "1" });
  assert.equal(plan.action, "reuse");
  assert.equal(plan.documentId, "doc_1");
});

test("a degraded document is not retried on the same parser version", () => {
  // Retrying would burn the same work to reach the same answer. The user's route
  // out of a degraded document is a better file or a newer parser, not patience.
  const plan = planIngest({ existing: existing({ state: "degraded", parser: "pdf" }), parser: "pdf", parserVersion: "1" });
  assert.equal(plan.action, "reuse");
});

test("a parser fix re-indexes the same bytes as a new version", () => {
  const plan = planIngest({ existing: existing({ parserVersion: "1" }), parser: "text", parserVersion: "2" });
  assert.equal(plan.action, "supersede");
  assert.equal(plan.version, 2);
  assert.equal(plan.supersedes, "doc_1");
});

test("a document abandoned mid-extraction is superseded, not left stuck", () => {
  // A route killed between "extracting" and "ready" leaves a row nothing will
  // ever finish. Without this, re-uploading the file would hit the checksum and
  // reuse the stuck document forever.
  const plan = planIngest({ existing: existing({ state: "extracting", parser: "pdf" }), parser: "pdf", parserVersion: "1" });
  assert.equal(plan.action, "supersede");
  assert.equal(plan.version, 2);
});

test("a failed document is retried, because failure is usually transient", () => {
  const plan = planIngest({ existing: existing({ state: "failed", parser: "pdf" }), parser: "pdf", parserVersion: "1" });
  assert.equal(plan.action, "supersede");
});

test("bytes never seen before are indexed as version 1", () => {
  const plan = planIngest({ existing: null, parser: "pdf", parserVersion: "1" });
  assert.equal(plan.action, "create");
  assert.equal(plan.version, 1);
  assert.equal(plan.supersedes, null);
});

/* -------------------------------------------------------------------------- */
/* Ingest against a fake store                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The store is injected precisely so this can exist. It records the transitions
 * rather than the rows, because the transitions are the contract: a document
 * that reaches `ready` without passing through `extracting` and `indexing` has
 * no way to drive a progress UI, and one that never leaves `extracting` is the
 * stuck row `planIngest` has to rescue later.
 */
function fakeStore(over: Partial<KnowledgeStore> = {}) {
  const states: string[] = [];
  const jobStates: string[] = [];
  const documents = new Map<string, KnowledgeDocumentRecord>();
  let blocks: KnowledgeBlockInput[] = [];
  let errors: Array<string | null | undefined> = [];
  let ownerScoped = true;
  let seq = 0;

  const store: KnowledgeStore = {
    async latestByChecksum(userId, checksum) {
      void checksum;
      if (userId !== "user_1") ownerScoped = false;
      return null;
    },
    async createDocument(input) {
      seq += 1;
      const id = `doc_${seq}`;
      documents.set(id, { id, state: "queued", version: input.version, parser: input.parser, parserVersion: input.parserVersion });
      states.push("queued");
      return id;
    },
    async updateDocument(userId, documentId, patch) {
      if (userId !== "user_1") ownerScoped = false;
      if (patch.state) states.push(patch.state);
      if ("error" in patch) errors.push(patch.error);
      const existing = documents.get(documentId);
      if (existing && patch.state) existing.state = patch.state;
    },
    async replaceBlocks(userId, _documentId, next) {
      if (userId !== "user_1") ownerScoped = false;
      blocks = next;
    },
    async createJob() {
      jobStates.push("queued");
      return "job_1";
    },
    async updateJob(userId, _jobId, patch) {
      if (userId !== "user_1") ownerScoped = false;
      jobStates.push(patch.state);
    },
    ...over,
  };

  return {
    store,
    states,
    jobStates,
    get blocks() {
      return blocks;
    },
    get errors() {
      return errors.filter((e): e is string => typeof e === "string" && e.length > 0);
    },
    get ownerScoped() {
      return ownerScoped;
    },
    reset() {
      errors = [];
    },
  };
}

const ingestInput = (fileName: string, body: Uint8Array) => ({
  userId: "user_1",
  attachmentId: "att_1",
  projectId: null,
  fileName,
  mimeType: "application/octet-stream",
  bytes: body,
});

test("a readable file walks queued → extracting → indexing → ready, with blocks", async () => {
  const fake = fakeStore();
  const outcome = await runIngest(
    fake.store,
    ingestInput("guide.md", utf8("# Guide\n\nOne paragraph of prose.\n"))
  );

  assert.equal(outcome.status, "indexed");
  assert.equal(outcome.status === "indexed" && outcome.state, "ok");
  assert.deepEqual(fake.states, ["queued", "extracting", "indexing", "ready"]);
  assert.deepEqual(fake.jobStates, ["queued", "running", "done"]);
  assert.ok(fake.blocks.length >= 2);
  // Ordinals are what restore reading order after retrieval scrambles it.
  assert.deepEqual(
    fake.blocks.map((b) => b.ordinal),
    fake.blocks.map((_, i) => i)
  );
  assert.equal(fake.blocks[0].path, "guide.md");
  assert.ok(fake.ownerScoped, "every store call must be scoped to the owner");
});

test("a scanned pdf lands in degraded with the reason attached, and still finishes its job", async () => {
  const fake = fakeStore();
  const bytes = pdfOf(["q 612 0 0 792 0 0 cm /Im1 Do Q"]);
  const outcome = await runIngest(fake.store, ingestInput("scan.pdf", bytes));

  assert.equal(outcome.status === "indexed" && outcome.state, "degraded");
  assert.deepEqual(fake.states, ["queued", "extracting", "indexing", "degraded"]);
  assert.deepEqual(fake.jobStates, ["queued", "running", "done"]);
  assert.match(fake.errors.join(" "), /scan|no text layer/i);
});

test("an unreadable file lands in failed without ever reaching indexing", async () => {
  const fake = fakeStore();
  const outcome = await runIngest(fake.store, ingestInput("broken.docx", new Uint8Array(64).fill(0x41)));

  assert.equal(outcome.status === "indexed" && outcome.state, "failed");
  assert.deepEqual(fake.states, ["queued", "extracting", "failed"]);
  assert.deepEqual(fake.jobStates, ["queued", "running", "failed"]);
  assert.ok(fake.errors[0].length > 10, "the failure must carry a sentence, not a code");
});

test("an image creates no document at all", async () => {
  const fake = fakeStore();
  const outcome = await runIngest(fake.store, ingestInput("photo.png", utf8("not really a png")));
  assert.equal(outcome.status, "skipped");
  assert.deepEqual(fake.states, []);
  assert.deepEqual(fake.jobStates, []);
});

test("re-uploading identical bytes writes nothing the second time", async () => {
  const bytes = utf8("# Guide\n\nOne paragraph of prose.\n");
  const checksum = checksumOf(bytes);
  const fake = fakeStore({
    async latestByChecksum() {
      return { id: "doc_existing", state: "ready", version: 1, parser: "text", parserVersion: "1" };
    },
  });

  const outcome = await runIngest(fake.store, ingestInput("guide.md", bytes));
  assert.equal(outcome.status, "reused");
  assert.equal(outcome.status === "reused" && outcome.documentId, "doc_existing");
  assert.deepEqual(fake.states, [], "no document row may be created for bytes already indexed");
  // The checksum is over content, so the same bytes under a different name are
  // still the same document.
  assert.equal(checksum, checksumOf(utf8("# Guide\n\nOne paragraph of prose.\n")));
});

test("a superseded predecessor is marked stale rather than deleted", async () => {
  const fake = fakeStore({
    async latestByChecksum() {
      return { id: "doc_old", state: "ready", version: 1, parser: "text", parserVersion: "0" };
    },
  });
  await runIngest(fake.store, ingestInput("guide.md", utf8("# Guide\n\nProse.\n")));
  // ...queued, extracting, indexing, ready, then the old version goes stale.
  assert.equal(fake.states[fake.states.length - 1], "stale");
});

test("an unreachable database is reported, not thrown at a request that already returned", async () => {
  const fake = fakeStore({
    async createDocument() {
      throw new Error("connection refused");
    },
  });
  const outcome = await runIngest(fake.store, ingestInput("guide.md", utf8("# Guide\n\nProse.\n")));
  assert.equal(outcome.status, "unavailable");
  assert.equal(outcome.status === "unavailable" && outcome.reason, "connection refused");
});

test("a store that fails mid-write still parks the document in failed", async () => {
  const fake = fakeStore({
    async replaceBlocks() {
      throw new Error("deadlock detected");
    },
  });
  const outcome = await runIngest(fake.store, ingestInput("guide.md", utf8("# Guide\n\nProse.\n")));
  assert.equal(outcome.status === "indexed" && outcome.state, "failed");
  assert.equal(fake.states[fake.states.length - 1], "failed");
  assert.equal(fake.jobStates[fake.jobStates.length - 1], "failed");
});

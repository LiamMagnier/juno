import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { Workbook } from "exceljs";
import { extractDocx } from "@/lib/knowledge/extract/docx";
import { readSheets, toReaderBlocks } from "@/lib/documents/reader-blocks";
import {
  findOccurrences,
  formatLabelOf,
  joinSoftWraps,
  splitDelimitedLine,
  splitPipeTable,
  textFlavorOf,
  viewerKindOf,
} from "@/lib/documents/viewer-kind";
import {
  documentLocationLabel,
  parseQuotedMessage,
  quoteLocationLabel,
  serializeQuote,
  type ArtifactQuote,
  type DocumentQuote,
} from "@/lib/quote-context";

/*
 * The document viewer's pure half: which viewer a file opens in, and the quote
 * a selection becomes. The quote is the contract that matters most — it is the
 * text the model is sent AND the text the transcript reads back into a card —
 * so every shape is round-tripped through serialize → parse here.
 */

const file = (fileName: string, mimeType = "application/octet-stream", kind: "IMAGE" | "FILE" = "FILE") => ({
  kind,
  fileName,
  mimeType,
});

test("a file opens in the viewer its format needs — the name leads, the label follows", () => {
  assert.equal(viewerKindOf(file("k3_tech_report.pdf", "application/pdf")), "pdf");
  // Mislabelled by the sender: the extension still says PDF.
  assert.equal(viewerKindOf(file("scan.pdf")), "pdf");
  // No extension, but the stored type was sniffed from the bytes.
  assert.equal(viewerKindOf(file("scan", "application/pdf")), "pdf");
  assert.equal(viewerKindOf(file("photo.png", "image/png", "IMAGE")), "image");
  assert.equal(viewerKindOf(file("notes.docx")), "document");
  assert.equal(viewerKindOf(file("deck.pptx")), "document");
  assert.equal(viewerKindOf(file("model.xlsx")), "document");
  assert.equal(viewerKindOf(file("letter.odt")), "document");
  assert.equal(
    viewerKindOf(file("untitled", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")),
    "document",
  );
  assert.equal(viewerKindOf(file("README.md", "text/markdown")), "text");
  assert.equal(viewerKindOf(file("data.csv")), "text");
  assert.equal(viewerKindOf(file("main.rs")), "text");
  assert.equal(viewerKindOf(file("config", "application/json")), "text");
  assert.equal(viewerKindOf(file("clip.mp4", "video/mp4")), "video");
  assert.equal(viewerKindOf(file("archive.zip", "application/zip")), "unsupported");
});

test("the header names a file in a reader's words", () => {
  assert.equal(formatLabelOf(file("a.pdf", "application/pdf")), "PDF");
  assert.equal(formatLabelOf(file("a.docx")), "Word document");
  assert.equal(formatLabelOf(file("a.pptx")), "PowerPoint deck");
  assert.equal(formatLabelOf(file("a.xlsx")), "Excel workbook");
  assert.equal(formatLabelOf(file("a.md")), "Markdown");
  assert.equal(formatLabelOf(file("a.csv")), "CSV");
  assert.equal(formatLabelOf(file("a.txt")), "Text");
  assert.equal(formatLabelOf(file("a.py")), "PY");
  assert.equal(textFlavorOf("notes.markdown"), "markdown");
  assert.equal(textFlavorOf("server.log"), "plain");
  assert.equal(textFlavorOf("main.go"), "code");
});

test("a delimited line keeps quoted delimiters and unescapes doubled quotes", () => {
  assert.deepEqual(splitDelimitedLine('a,"b, c","say ""hi""",', ","), ["a", "b, c", 'say "hi"', ""]);
  assert.deepEqual(splitDelimitedLine("x\ty\t\tz", "\t"), ["x", "y", "", "z"]);
  assert.deepEqual(splitPipeTable("Name | Qty\nApples | 3\n\n"), [
    ["Name", "Qty"],
    ["Apples", "3"],
  ]);
});

test("find steps through case-insensitive, non-overlapping matches", () => {
  assert.deepEqual(findOccurrences("Revenue grew; revenue fell. REVENUE.", "revenue"), [
    [0, 7],
    [14, 21],
    [28, 35],
  ]);
  assert.deepEqual(findOccurrences("aaaa", "aa"), [
    [0, 2],
    [2, 4],
  ]);
  assert.deepEqual(findOccurrences("anything", "   "), []);
  assert.equal(findOccurrences("x".repeat(100), "x", 10).length, 10);
});

test("locations are spelled in the file's own terms", () => {
  assert.equal(documentLocationLabel({ page: 4 }), "page 4");
  assert.equal(documentLocationLabel({ page: 4, pageEnd: 5 }), "pages 4–5");
  assert.equal(documentLocationLabel({ page: 4, pageEnd: 5 }, "-"), "pages 4-5");
  assert.equal(documentLocationLabel({ slide: 2 }), "slide 2");
  assert.equal(documentLocationLabel({ sheet: "Revenue" }), "sheet Revenue");
  assert.equal(documentLocationLabel({ lineStart: 3, lineEnd: 9 }), "lines 3–9");
  assert.equal(documentLocationLabel(undefined), null);
});

const passage: DocumentQuote = {
  source: "document",
  attachmentId: "att_1",
  title: "k3_tech_report.pdf",
  kind: "text",
  text: "The encoder uses 12 layers.\nEach has 16 heads.",
  location: { page: 4, pageEnd: 5 },
  mode: "ask",
};

test("a document passage serializes to a block the model can anchor on", () => {
  const sent = serializeQuote(passage, "  Why so many heads?  ");
  assert.match(sent, /^\[Selection from document "k3_tech_report\.pdf", pages 4-5\]:\n"""\n/);
  assert.match(sent, /Why so many heads\?/);
  assert.match(sent, /quoted verbatim from the attached document/);
  assert.equal(quoteLocationLabel(passage), "pages 4–5");
});

test("a document passage reads back into a card: title, place, words, and only what was typed", () => {
  const parsed = parseQuotedMessage(serializeQuote(passage, "Why so many heads?"));
  assert.deepEqual(parsed, {
    source: "document",
    kind: "text",
    mode: "ask",
    title: "k3_tech_report.pdf",
    location: "pages 4–5",
    text: "The encoder uses 12 layers.\nEach has 16 heads.",
    request: "Why so many heads?",
  });
  // Explain is sent with a stock request; it reads back the same way.
  assert.equal(parseQuotedMessage(serializeQuote(passage, "Explain this passage in plain terms."))?.request, "Explain this passage in plain terms.");
});

test("an area carries its region to the model, and its words when the page had any", () => {
  const area: DocumentQuote = {
    source: "document",
    attachmentId: "att_1",
    title: "k3_tech_report.pdf",
    kind: "area",
    text: "Figure 3: loss vs. steps",
    location: { page: 6 },
    region: { x: 12.4, y: 30, width: 45.2, height: 34.1 },
    mode: "ask",
  };
  const sent = serializeQuote(area, "What does the dip mean?");
  assert.match(sent, /^\[Area from document "k3_tech_report\.pdf", page 6, region x 12-58%, y 30-64%\]:\n/);
  assert.match(sent, /The attached image is this area/);
  assert.match(sent, /Text inside the area:\n"""\nFigure 3: loss vs\. steps\n"""/);
  assert.equal(quoteLocationLabel(area), "page 6 · area");

  const parsed = parseQuotedMessage(sent);
  assert.equal(parsed?.kind, "area");
  assert.equal(parsed?.location, "page 6");
  assert.equal(parsed?.text, "Figure 3: loss vs. steps");
  assert.equal(parsed?.request, "What does the dip mean?");

  // Nothing typed and no text layer: the image is the question.
  const bare = serializeQuote({ ...area, text: "", location: undefined }, "");
  assert.match(bare, /Explain what this area shows/);
  const bareParsed = parseQuotedMessage(bare);
  assert.equal(bareParsed?.request, "");
  assert.equal(bareParsed?.text, "");
  assert.equal(bareParsed?.location, null);
});

test("artifact quotes keep their protocol and read back too", () => {
  const ask: ArtifactQuote = {
    artifactId: "a1",
    identifier: "pomodoro",
    title: "Pomodoro timer (v2)",
    baseVersion: 3,
    kind: "text",
    text: "const WORK = 25;",
    lineStart: 4,
    lineEnd: 9,
    mode: "ask",
  };
  const askSent = serializeQuote(ask, "Why 25?");
  assert.match(askSent, /^\[Selection from artifact "pomodoro" \(Pomodoro timer \(v2\)\), version 3, lines 4-9\]:/);
  assert.deepEqual(parseQuotedMessage(askSent), {
    source: "artifact",
    kind: "text",
    mode: "ask",
    title: "Pomodoro timer (v2)",
    location: "lines 4–9",
    text: "const WORK = 25;",
    request: "Why 25?",
  });

  const modify = { ...ask, kind: "element" as const, selector: ".card", lineStart: undefined, lineEnd: undefined, mode: "modify" as const };
  const parsed = parseQuotedMessage(serializeQuote(modify, "Make it blue"));
  assert.equal(parsed?.mode, "modify");
  assert.equal(parsed?.kind, "element");
  assert.equal(parsed?.location, "element .card");
  assert.equal(parsed?.request, "Make it blue");
});

test("anything that is not a block this module wrote is shown exactly as sent", () => {
  assert.equal(parseQuotedMessage("Just a question about page 4"), null);
  assert.equal(parseQuotedMessage('[Selection from document "a.pdf", page 1]:\n"""\nunclosed quote'), null);
  // The right header and fence, but a closing sentence the person wrote:
  // it is theirs, so it is not stripped and the card is not drawn.
  const tampered = serializeQuote(passage, "Question").replace(/Answer about this passage[\s\S]*$/, "My own ending.");
  assert.equal(parseQuotedMessage(tampered), null);
});

/* -------------------------------------------------------------------------- */
/* The reading view, from real office files                                    */
/* -------------------------------------------------------------------------- */


async function docxOf(bodyXml: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`,
  );
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}

const para = (text: string, style?: string, numbered = false) =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${numbered ? "<w:numPr/>" : ""}</w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;

test("a Word document reads as headings at their depth, prose, bullets and a table", async () => {
  const bytes = await docxOf(
    [
      para("Quarterly review", "Title"),
      para("Revenue", "Heading1"),
      para("Revenue grew in every region."),
      para("By channel", "Heading2"),
      para("Direct sales", undefined, true),
      "<w:tbl><w:tr><w:tc>" + para("Quarter") + "</w:tc><w:tc>" + para("Total") + "</w:tc></w:tr>" +
        "<w:tr><w:tc>" + para("Q1") + "</w:tc><w:tc>" + para("34") + "</w:tc></w:tr></w:tbl>",
    ].join(""),
  );
  const extracted = await extractDocx({ bytes, fileName: "review.docx" });
  const { blocks, truncated } = toReaderBlocks(extracted.blocks);
  assert.equal(truncated, false);
  assert.deepEqual(
    blocks.map((b) => [b.type, b.text, b.level ?? null]),
    [
      // Word's Title and Heading 1 share the outline's top rung (docx.ts pops
      // everything at level >= the new heading's), so both draw at level 1.
      ["heading", "Quarterly review", 1],
      ["heading", "Revenue", 1],
      ["paragraph", "Revenue grew in every region.", null],
      ["heading", "By channel", 2],
      ["list_item", "Direct sales", null],
      ["table", "Quarter | Total\nQ1 | 34", null],
    ],
  );
  assert.deepEqual(splitPipeTable(blocks[5].text), [
    ["Quarter", "Total"],
    ["Q1", "34"],
  ]);
});

test("a formula cell's second, citation-only copy never reaches the page", () => {
  const { blocks } = toReaderBlocks([
    { type: "table", text: "Quarter: Q1 | Total: 34", sheet: "Revenue", cellRange: "A2:B2" },
    { type: "table_cell", text: "B2 = A2*2 → 34", sheet: "Revenue", cellRange: "B2" },
    { type: "paragraph", text: "   " },
  ]);
  assert.deepEqual(blocks, [{ type: "table", text: "Quarter: Q1 | Total: 34", sheet: "Revenue" }]);
});

test("a workbook reads as grids — an empty cell keeps its column", async () => {
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet("Revenue");
  sheet.addRow(["Quarter", "Region", "Total"]);
  sheet.addRow(["Q1", null, 34]);
  sheet.addRow(["Q2", "EU", { formula: "C2*2", result: 68 }]);
  workbook.addWorksheet("Empty");
  const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());

  const read = await readSheets(bytes);
  assert.ok(read);
  assert.equal(read.truncated, false);
  assert.deepEqual(read.sheets[0], {
    name: "Revenue",
    rows: [
      ["Quarter", "Region", "Total"],
      ["Q1", "", "34"],
      ["Q2", "EU", "68"],
    ],
  });
  assert.deepEqual(read.sheets[1], { name: "Empty", rows: [] });
  assert.equal(await readSheets(new TextEncoder().encode("not a workbook")), null);
});

test("a PDF passage is re-flowed only where the page wrapped a sentence", () => {
  assert.equal(
    joinSoftWraps("We describe the architecture, training recipe and serving stack of K3, and report\nresults on three public benchmarks. On MS MARCO, K3-L reaches 0.912 recall at ten\nwith a median latency of 11 ms."),
    "We describe the architecture, training recipe and serving stack of K3, and report results on three public benchmarks. On MS MARCO, K3-L reaches 0.912 recall at ten with a median latency of 11 ms.",
  );
  assert.equal(joinSoftWraps("sparse retrie-\nval at scale"), "sparse retrieval at scale");
  // A sentence end, a heading and table rows keep their breaks.
  assert.equal(joinSoftWraps("It ends here.\nNext one"), "It ends here.\nNext one");
  assert.equal(joinSoftWraps("K3-S 66M 0.897\nK3-M 110M 0.906"), "K3-S 66M 0.897\nK3-M 110M 0.906");
  assert.equal(joinSoftWraps("1 Introduction\nK3 is a sparse"), "1 Introduction\nK3 is a sparse");
});

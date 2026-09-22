import assert from "node:assert/strict";
import test from "node:test";
import { isAcceptedMime, isTextExtractable, ACCEPT_ATTRIBUTE, OFFICE_MIME } from "@/lib/uploads";
import { selectExtractor, extractDocument } from "@/lib/knowledge/extract";
import { extractPdf } from "@/lib/knowledge/extract/pdf";

/*
 * Whether a person's file can actually be read.
 *
 * Every claim below was a real defect, and each was invisible in the same way:
 * the file was refused, or mis-read, or silently starved of its own bytes, and
 * the only symptom anybody ever saw was a model saying it had no text. So the
 * fixtures are real bytes — a PDF assembled object by object, and Office files
 * built by the very libraries this repo ships — rather than mocks of a parser.
 */

/* -------------------------------------------------------------------------- */
/* The upload door                                                             */
/* -------------------------------------------------------------------------- */

test("the formats Juno can read are the formats Juno accepts", () => {
  /*
   * THE GAP THIS CLOSES. `selectExtractor` has claimed .docx, .xlsx and .pptx
   * by extension and by MIME for as long as those extractors have existed, and
   * all three read a real file correctly — but `isAcceptedMime` did not list
   * them, so the upload was refused 415 and the picker never offered them. The
   * commonest documents in professional use were the ones Juno could read and
   * would not take.
   */
  const office: [string, string][] = [
    ["report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["book.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ];
  for (const [name, mime] of office) {
    assert.ok(isAcceptedMime(mime), `${name} must be accepted at upload`);
    assert.ok(selectExtractor(name, mime), `${name} must have an extractor`);
    // A .docx is a ZIP. Decoding one as UTF-8 at upload time would store a
    // column of mojibake as the file's "text" and hand it to a model.
    assert.equal(isTextExtractable(mime), false, `${name} must not be decoded as text`);
    assert.ok(ACCEPT_ATTRIBUTE.includes(mime), `${name} must be offered by the file picker`);
  }
  // The extension rides along too: Windows without Office reports a .docx as
  // octet-stream, and a picker keyed on MIME alone greys out the very file the
  // person is looking at.
  for (const ext of [".docx", ".xlsx", ".pptx"]) assert.ok(ACCEPT_ATTRIBUTE.includes(ext));
});

test("a browser that shouts the MIME type is still understood", () => {
  // Some clients send the type uppercase, or with a charset parameter. Both
  // used to fail an exact-match lookup and reject a perfectly ordinary file.
  assert.ok(isAcceptedMime(OFFICE_MIME[0].toUpperCase()));
  assert.ok(isAcceptedMime(`${OFFICE_MIME[0]}; charset=binary`));
  assert.ok(isAcceptedMime("APPLICATION/PDF"));
});

test("types that could render inline are still refused", () => {
  // The allowlist got wider; the XSS rule did not move.
  for (const blocked of ["text/html", "application/xhtml+xml", "image/svg+xml"]) {
    assert.equal(isAcceptedMime(blocked), false, `${blocked} must stay blocked`);
  }
});

/* -------------------------------------------------------------------------- */
/* The PDF ladder                                                              */
/* -------------------------------------------------------------------------- */

/** A real, readable PDF. `trailerExtra` goes verbatim into the trailer dict. */
function buildPdf(text: string, trailerExtra = ""): Uint8Array {
  const stream = `BT /F1 14 Tf 60 700 Td (${text}) Tj ET\n`;
  const objects = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Kids [4 0 R] /Count 1 >>\nendobj\n`,
    `3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
    `4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>\nendobj\n`,
    `5 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(pdf.length);
    pdf += object;
  }
  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailerExtra} >>\nstartxref\n${startxref}\n%%EOF\n`;
  // latin1: a PDF is a byte format and the offsets recorded above are byte
  // offsets, so any multi-byte encoding shifts every one of them.
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

const textOf = (result: { blocks: readonly { text: string }[] } | null) =>
  (result?.blocks ?? []).map((block) => block.text).join(" ");

test("a readable PDF the native parser calls encrypted is still read", async () => {
  /*
   * THE BUG, AND WHY IT WAS EXPENSIVE. The native parser decides "encrypted"
   * with a regex for `/Encrypt N G R` over the trailer region — which an
   * incremental save, or a permissions-only PDF that opens with an empty
   * password (most government forms and bank statements), trips while being
   * perfectly readable. That verdict was `failed`, and `extractDocument`
   * returned on `failed` BEFORE the pdf.js rung, so the one engine that could
   * have contradicted it was never asked. The file became "COULDN'T READ THIS
   * FILE" for a document with its text sitting in plain view.
   */
  const bytes = buildPdf("Basic personal amount 16129", " /Prev 0 /Encrypt 9 0 R");

  const native = extractPdf({ bytes: bytes.slice(), fileName: "td1.pdf" });
  assert.equal(native.status, "failed", "the native parser's false positive is the precondition");
  assert.match(native.reason ?? "", /password-protected/);

  const ladder = await extractDocument({ bytes: bytes.slice(), fileName: "td1.pdf", mimeType: "application/pdf" });
  assert.equal(ladder?.status, "ok", "the ladder must not inherit the false positive");
  assert.match(textOf(ladder), /16129/, "the text was always there to be read");
  // The contradicted verdict must not ride along: a document that read fine
  // cannot keep a reason that says it is locked.
  assert.equal(ladder?.reason, undefined);
});

test("the rescue does not turn an unreadable file into a readable one", async () => {
  /*
   * The point of letting `failed` fall through to pdf.js is to stop the native
   * parser's false positives ending a file's life — NOT to make failure
   * impossible. A file no engine can open must still fail, or the fix has
   * simply moved the lie somewhere else.
   *
   * Two real ones, neither synthesisable as a fixture, were checked against
   * the py-pdf sample corpus while this was written: a genuinely
   * password-protected document still ends `failed` ("No password given"), and
   * a file with a broken catalog still ends `failed` ("Invalid Root
   * reference"). What is asserted here is the case a test can own outright —
   * a PDF header over bytes that are not a PDF.
   */
  const corrupt = new Uint8Array(Buffer.from(`%PDF-1.4\n${"\x00\xff".repeat(400)}\n%%EOF\n`, "latin1"));
  const ladder = await extractDocument({ bytes: corrupt, fileName: "damaged.pdf", mimeType: "application/pdf" });
  assert.notEqual(ladder?.status, "ok", "bytes that are not a document must not report success");
  assert.equal(textOf(ladder), "", "and must not invent text");

  // A file that is not a PDF at all is refused on its header, before any
  // engine is asked to guess at it.
  const notPdf = new Uint8Array(Buffer.from("just a text file, honestly", "latin1"));
  const nope = await extractDocument({ bytes: notPdf, fileName: "fake.pdf", mimeType: "application/pdf" });
  assert.equal(nope?.status, "failed");
});

test("extraction does not destroy the bytes it was given", async () => {
  /*
   * THE INVISIBLE ONE. pdf.js TRANSFERS its input buffer — measured on a real
   * file, byteLength goes 16978 → 0 the moment `getDocumentProxy` returns. The
   * PDF ladder ran the pdf.js rung and then handed `input.bytes` to OCR, so
   * OCR received a zero-length buffer on every document that reached it. It
   * could not have OCR'd a page even on a host with tesseract installed, and
   * the symptom — "this scan has no text" — was indistinguishable from OCR
   * running and finding nothing. That is why it survived so long, and why it
   * gets a test rather than a comment.
   */
  const bytes = buildPdf("Revenue rose to 4.2 million");
  const before = bytes.byteLength;
  assert.ok(before > 0);

  await extractDocument({ bytes, fileName: "report.pdf", mimeType: "application/pdf" });

  assert.equal(bytes.byteLength, before, "the caller's buffer must survive extraction");
  // And it must still be readable, not merely present.
  const again = await extractDocument({ bytes, fileName: "report.pdf", mimeType: "application/pdf" });
  assert.match(textOf(again), /4\.2 million/, "a second read of the same buffer must work");
});

test("a PDF with a text layer reads without needing any fallback", async () => {
  const ladder = await extractDocument({
    bytes: buildPdf("The committee published its findings in March"),
    fileName: "minutes.pdf",
    mimeType: "application/pdf",
  });
  assert.equal(ladder?.status, "ok");
  assert.match(textOf(ladder), /committee published its findings/);
});

test("rendering a page does not destroy the document it rendered from", async () => {
  /*
   * The same transfer bug as above, in the module that draws pages. pdf.js
   * takes the buffer it is handed, so a caller that renders a thumbnail and
   * then wants to read the file — or render a second page — was left holding
   * a detached, zero-length array. Rendering a page must not be a way of
   * losing the document.
   */
  const { renderDocumentPage } = await import("@/lib/media/raster");
  const bytes = buildPdf("Quarterly Report");
  const before = bytes.byteLength;

  const first = await renderDocumentPage({ bytes, page: 1, targetWidth: 200 });
  if (!first) return; // no canvas binding on this platform; nothing to assert
  assert.equal(bytes.byteLength, before, "the caller's buffer must survive rendering");

  // And the proof that it is not merely present but usable: render again, and
  // read the text out of the very same array.
  const second = await renderDocumentPage({ bytes, page: 1, targetWidth: 200 });
  assert.ok(second, "a second render of the same buffer must work");
  assert.match(textOf(await extractDocument({ bytes, fileName: "r.pdf", mimeType: "application/pdf" })), /Quarterly Report/);
});

test("an oversized document is not base64-inlined into the request", async () => {
  /*
   * Base64 inflates by a third, and Anthropic caps a Messages request at
   * 32 MB — so a 24 MB PDF is already at the limit before the conversation is
   * added, and an unguarded inline fails the whole TURN rather than the one
   * attachment. No adapter checked. The ceiling has to leave room for
   * everything else in the request, and for the stricter partner platforms
   * (Bedrock 20 MB).
   */
  const { MAX_INLINE_DOCUMENT_BYTES, canInlineDocument, oversizeDocumentNote } = await import(
    "@/lib/attachment-bytes"
  );
  assert.ok(MAX_INLINE_DOCUMENT_BYTES * (4 / 3) < 20 * 1024 * 1024, "must clear Bedrock's 20 MB once encoded");
  assert.equal(canInlineDocument(1024), true);
  assert.equal(canInlineDocument(MAX_INLINE_DOCUMENT_BYTES + 1), false);
  assert.equal(canInlineDocument(0), false, "an empty object is not something to send");

  // The note must send the model somewhere, not just apologise — an apology
  // alone invites it to answer from the filename.
  assert.match(oversizeDocumentNote("big.pdf", 40 * 1024 * 1024, false), /read_document|inspect_image/);
  assert.match(oversizeDocumentNote("big.pdf", 40 * 1024 * 1024, false), /Do not describe its contents/);
});

test("a PDF a browser mislabelled is still recognised as one", async () => {
  /*
   * Browsers send `application/octet-stream` for a PDF whenever no reader is
   * installed, and every adapter tested `mimeType === "application/pdf"`
   * before taking the raw-bytes path. So a mislabelled PDF silently lost the
   * one path that lets Claude and Gemini read a scan.
   */
  const { sniffDocumentMime } = await import("@/lib/uploads");
  const { isPdfAttachment } = await import("@/lib/attachment-bytes");

  assert.equal(sniffDocumentMime(buildPdf("hello")), "application/pdf");
  assert.equal(sniffDocumentMime(new Uint8Array(Buffer.from("not a pdf"))), null);

  // Rows already in the database were stored before sniffing existed, so the
  // name is the evidence that survives for them.
  assert.equal(isPdfAttachment({ mimeType: "application/octet-stream", fileName: "td1.pdf" }), true);
  assert.equal(isPdfAttachment({ mimeType: "application/pdf", fileName: "td1" }), true);
  assert.equal(isPdfAttachment({ mimeType: "application/octet-stream", fileName: "notes.bin" }), false);
});

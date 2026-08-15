import test from "node:test";
import assert from "node:assert/strict";
import {
  extractPdfText,
  looksLikePdf,
  readBodyBounded,
  responseIsPdf,
  MAX_PDF_BYTES,
  MAX_PDF_PAGES,
} from "@/lib/search/pdf-text";

/**
 * The PDF reader, held down against real bytes.
 *
 * Every fixture below is an actual PDF assembled byte by byte — correct object
 * offsets, a real cross-reference table, a real trailer — and handed to the real
 * parser. A mocked `extractText` would have passed on the day this landed and
 * every day after, including the days the dependency changed under us, which is
 * the whole thing the fixture is here to catch: the claim being tested is not
 * "our wrapper calls a library", it is "text comes out of a PDF".
 *
 * pdf-text.ts is deliberately not `server-only` so this file can reach it — the
 * same split fusion.ts and url-safety.ts already document.
 */

// ---------------------------------------------------------------------------
// A PDF builder, because there is no such thing as a valid PDF you can write as
// a string literal: every object's byte offset has to appear in the xref table,
// so the file has to be assembled and measured, not typed out.
// ---------------------------------------------------------------------------

interface PageSpec {
  /** Text drawn with a standard font, i.e. a real text layer. */
  text?: string;
  /** A raw content stream instead — used to build a page that has ink but no text. */
  raw?: string;
  /** A link annotation target, the only place a PDF's outbound URLs live. */
  link?: string;
}

interface PdfSpec {
  pages: PageSpec[];
  info?: Record<string, string>;
  /** Adds a standard-security /Encrypt dictionary with a key nothing can match. */
  encrypt?: boolean;
}

function buildPdf({ pages, info, encrypt = false }: PdfSpec): Uint8Array {
  const objects: string[] = [];
  // Object numbering is fixed up front so /Kids can reference pages that have
  // not been written yet: 1 catalog, 2 page tree, 3 font, then three slots per
  // page (page, content stream, annotation).
  const pageObjNum = (i: number) => 4 + i * 3;
  const kids = pages.map((_, i) => `${pageObjNum(i)} 0 R`).join(" ");

  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);
  objects.push(`3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);

  pages.forEach((page, i) => {
    const num = pageObjNum(i);
    const contentNum = num + 1;
    const annotNum = num + 2;
    const annots = page.link ? ` /Annots [${annotNum} 0 R]` : "";
    objects.push(
      `${num} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >>${annots} /Contents ${contentNum} 0 R >>\nendobj\n`
    );
    const stream = page.raw ?? `BT /F1 12 Tf 72 720 Td (${page.text ?? ""}) Tj ET\n`;
    objects.push(`${contentNum} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`);
    // The slot is reserved either way so the numbering above stays predictable.
    objects.push(
      page.link
        ? `${annotNum} 0 obj\n<< /Type /Annot /Subtype /Link /Rect [72 700 300 730] /Border [0 0 0] ` +
            `/A << /Type /Action /S /URI /URI (${page.link}) >> >>\nendobj\n`
        : `${annotNum} 0 obj\nnull\nendobj\n`
    );
  });

  let trailerExtras = "";
  if (info) {
    const num = objects.length + 1;
    const entries = Object.entries(info)
      .map(([k, v]) => `/${k} (${v})`)
      .join(" ");
    objects.push(`${num} 0 obj\n<< ${entries} >>\nendobj\n`);
    trailerExtras += ` /Info ${num} 0 R`;
  }
  if (encrypt) {
    const num = objects.length + 1;
    // /O and /U are the owner and user password hashes. Filling them with a
    // constant means the empty password cannot validate, which is precisely the
    // state a downloaded protected document arrives in.
    const unmatchable = "A".repeat(32);
    objects.push(`${num} 0 obj\n<< /Filter /Standard /V 1 /R 2 /O (${unmatchable}) /U (${unmatchable}) /P -1 >>\nendobj\n`);
    trailerExtras += ` /Encrypt ${num} 0 R /ID [<0123456789abcdef0123456789abcdef> <0123456789abcdef0123456789abcdef>]`;
  }

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj;
  }
  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailerExtras} >>\nstartxref\n${startxref}\n%%EOF\n`;

  // latin1, not utf8: a PDF is a byte format and the offsets recorded above are
  // byte offsets. Encoding as utf8 shifts every one of them the moment a single
  // non-ASCII character appears and the file stops parsing.
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

const BUDGET = 16_000;

// ---------------------------------------------------------------------------
// The claim: text comes out of a PDF
// ---------------------------------------------------------------------------

test("extracts the text of every page of a real PDF", async () => {
  const bytes = buildPdf({
    pages: [{ text: "The committee published its findings in March." }, { text: "Adoption reached sixty-one percent." }],
  });
  // If this fixture ever stops being small, the test has stopped being a test of
  // a hand-built document and started being a test of a checked-in binary.
  assert.ok(bytes.byteLength < 4096, `fixture should stay tiny, was ${bytes.byteLength} bytes`);

  const result = await extractPdfText(bytes, { maxChars: BUDGET });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.text, /committee published its findings in March/);
  assert.match(result.text, /Adoption reached sixty-one percent/);
  assert.equal(result.pages, 2);
  assert.equal(result.pagesRead, 2);
});

test("carries the document's own title, author and date when it has them", async () => {
  const bytes = buildPdf({
    pages: [{ text: "Annual report body text goes here." }],
    info: { Title: "Annual Report 2031", Author: "Office of the Auditor", CreationDate: "D:20310615090000Z" },
  });

  const result = await extractPdfText(bytes, { maxChars: BUDGET });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.title, "Annual Report 2031");
  assert.equal(result.author, "Office of the Auditor");
  // The /Info form is `D:YYYYMMDD…`, which Date.parse cannot read at all — a
  // regression here yields an Invalid Date rather than a visible error.
  assert.equal(result.publishedAt?.getUTCFullYear(), 2031);
  assert.equal(result.publishedAt?.getUTCMonth(), 5);
});

test("ignores a /Title that is only the producing application's filename", async () => {
  const bytes = buildPdf({
    pages: [{ text: "Body text long enough to be a document." }],
    info: { Title: "Microsoft Word - draft7.docx" },
  });

  const result = await extractPdfText(bytes, { maxChars: BUDGET });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // Undefined, so the caller falls back to the URL — which tells a reader more
  // than the name of a file on a stranger's desktop.
  assert.equal(result.title, undefined);
});

// ---------------------------------------------------------------------------
// Links, and the guard on them
// ---------------------------------------------------------------------------

test("collects link annotations and refuses the ones pointing inside the network", async () => {
  const bytes = buildPdf({
    pages: [
      { text: "See the referenced specification.", link: "https://example.org/spec.html" },
      { text: "And the internal build server.", link: "http://127.0.0.1:8080/admin" },
      { text: "And the metadata endpoint.", link: "http://169.254.169.254/latest/meta-data/" },
    ],
  });

  const result = await extractPdfText(bytes, { maxChars: BUDGET });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // A fetched PDF is an untrusted party handing us URLs and these reach fetch(),
  // so the same host guard the HTML path applies has to apply here.
  assert.deepEqual(result.links, ["https://example.org/spec.html"]);
});

// ---------------------------------------------------------------------------
// The bounds
// ---------------------------------------------------------------------------

test("stops at the page ceiling instead of parsing an arbitrarily long document", async () => {
  const pages = Array.from({ length: MAX_PDF_PAGES + 5 }, (_, i) => ({ text: `Page ${i + 1} marker.` }));
  const result = await extractPdfText(buildPdf({ pages }), { maxChars: BUDGET });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.pages, MAX_PDF_PAGES + 5, "the document's real length is still reported");
  assert.equal(result.pagesRead, MAX_PDF_PAGES);
  assert.match(result.text, new RegExp(`Page ${MAX_PDF_PAGES} marker`));
  assert.doesNotMatch(result.text, new RegExp(`Page ${MAX_PDF_PAGES + 1} marker`));
});

test("stops as soon as the character budget is met", async () => {
  const pages = Array.from({ length: 30 }, (_, i) => ({ text: `Page ${i + 1} marker.` }));
  const result = await extractPdfText(buildPdf({ pages }), { maxChars: 40 });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.text.length <= 40, `text was ${result.text.length} chars`);
  // The point is not the truncation — it is that the pages past the budget were
  // never parsed, which is where the CPU time would have gone.
  assert.ok(result.pagesRead < 10, `read ${result.pagesRead} pages to fill 40 characters`);
});

test("refuses a document larger than the byte ceiling without parsing it", async () => {
  const oversized = new Uint8Array(MAX_PDF_BYTES + 1);
  oversized.set([0x25, 0x50, 0x44, 0x46, 0x2d]); // a real %PDF- header, so only the size decides
  const result = await extractPdfText(oversized, { maxChars: BUDGET });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "too_large");
});

test("abandons the page loop when the caller's signal aborts", async () => {
  const pages = Array.from({ length: 20 }, (_, i) => ({ text: `Page ${i + 1} marker.` }));
  const controller = new AbortController();
  controller.abort();
  const result = await extractPdfText(buildPdf({ pages }), { maxChars: BUDGET, signal: controller.signal });

  // Nothing was read, so there is no text — reported as the honest "no text"
  // outcome rather than as a parse failure, because the file was fine.
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "no_text_layer");
});

// ---------------------------------------------------------------------------
// The failures, which must all be values rather than exceptions: this runs
// inside the research engine's READ stage, where a throw ends the round.
// ---------------------------------------------------------------------------

test("reports a password-protected document as encrypted", async () => {
  const result = await extractPdfText(buildPdf({ pages: [{ text: "Confidential." }], encrypt: true }), {
    maxChars: BUDGET,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "encrypted");
});

test("reports a corrupted document as malformed rather than throwing", async () => {
  // A valid header — so it gets past the magic-byte check — followed by nothing
  // a parser can use. This is what a truncated download looks like.
  const truncated = new Uint8Array(Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catal", "latin1"));
  const result = await extractPdfText(truncated, { maxChars: BUDGET });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "malformed");
});

test("reports a scan with no text layer as exactly that", async () => {
  // A page that draws a filled rectangle and no glyphs: valid, parseable, and
  // completely empty of text — the shape every scanned document arrives in.
  const result = await extractPdfText(buildPdf({ pages: [{ raw: "0.5 0.5 0.5 rg 100 100 400 500 re f\n" }] }), {
    maxChars: BUDGET,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  // Not "malformed": telling a user their file is damaged when it is a
  // photocopy sends them looking for a problem that is not there.
  assert.equal(result.reason, "no_text_layer");
});

test("rejects bytes that are not a PDF before reaching the parser", async () => {
  const html = new Uint8Array(Buffer.from("<!doctype html><title>Sign in</title>", "latin1"));
  const result = await extractPdfText(html, { maxChars: BUDGET });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "not_a_pdf");
});

// ---------------------------------------------------------------------------
// Which door a response goes through
// ---------------------------------------------------------------------------

test("routes a response to the PDF parser on type, and on extension only when the type says nothing", () => {
  assert.equal(responseIsPdf("application/pdf", "https://example.org/a"), true);
  assert.equal(responseIsPdf("application/x-pdf", "https://example.org/a"), true);
  // The case this exists for: static hosts and object stores serve papers as a
  // generic binary type, and those are the primary sources a run most wants.
  assert.equal(responseIsPdf("application/octet-stream", "https://example.org/papers/2031.pdf"), true);
  assert.equal(responseIsPdf("", "https://example.org/papers/2031.PDF?download=1"), true);
  assert.equal(responseIsPdf("application/octet-stream", "https://example.org/archive.zip"), false);
  // A specific type is never overridden by the path: a .pdf URL answering with
  // HTML is a login wall or a landing page, and the HTML path reads those.
  assert.equal(responseIsPdf("text/html", "https://example.org/papers/2031.pdf"), false);
  assert.equal(responseIsPdf("image/png", "https://example.org/scan.pdf"), false);
});

// ---------------------------------------------------------------------------
// The byte ceiling, which is the guard between a research run and an arbitrary
// binary chosen by a stranger's web page
// ---------------------------------------------------------------------------

function streamingResponse(chunks: Uint8Array[], headers?: Record<string, string>): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, { headers });
}

test("reads a body that fits under the ceiling, reassembled in order", async () => {
  const res = streamingResponse([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]);
  const body = await readBodyBounded(res, 100);
  assert.deepEqual(body ? [...body] : null, [1, 2, 3, 4, 5]);
});

test("stops mid-stream rather than buffering a body past the ceiling", async () => {
  let delivered = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      delivered += 1;
      controller.enqueue(new Uint8Array(64));
    },
  });
  // No Content-Length at all — the header is a hint from the same party that
  // chose the body, so the running total has to be what enforces the bound.
  const result = await readBodyBounded(new Response(body), 256);

  assert.equal(result, null);
  // The point of streaming: an endless body costs a handful of chunks, not all
  // of it. `arrayBuffer()` here would never return.
  assert.ok(delivered < 20, `pulled ${delivered} chunks before giving up`);
});

test("refuses on a declared Content-Length over the ceiling without consuming the body", async () => {
  const res = streamingResponse([new Uint8Array(8)], { "content-length": String(MAX_PDF_BYTES + 1) });

  assert.equal(await readBodyBounded(res, MAX_PDF_BYTES), null);
  // An honest oversized Content-Length should cost nothing: the stream is left
  // undisturbed, so the connection can be released rather than drained. (The
  // stream's own queue may have been primed at construction — `bodyUsed` is the
  // flag that tracks whether anything actually read from it.)
  assert.equal(res.bodyUsed, false);
});

test("does not trust a Content-Length that understates the body", async () => {
  const res = streamingResponse([new Uint8Array(500)], { "content-length": "10" });
  assert.equal(await readBodyBounded(res, 100), null);
});

// ---------------------------------------------------------------------------
// The magic-byte check on its own
// ---------------------------------------------------------------------------

test("recognises a PDF header, including the offset ones producers emit", () => {
  assert.equal(looksLikePdf(new Uint8Array(Buffer.from("%PDF-1.7\n…", "latin1"))), true);
  // Some producers prepend junk; Acrobat and pdf.js both tolerate a small
  // offset, so a document that opens everywhere must not be refused here.
  assert.equal(looksLikePdf(new Uint8Array(Buffer.from("\n\n   %PDF-1.4\n", "latin1"))), true);
  assert.equal(looksLikePdf(new Uint8Array(Buffer.from("<!doctype html>", "latin1"))), false);
  assert.equal(looksLikePdf(new Uint8Array(0)), false);
  // The scan is bounded, so an HTML page that merely mentions the string a long
  // way in is still not a PDF.
  const decoy = new Uint8Array(Buffer.from(`<html>${" ".repeat(4000)}%PDF-1.4`, "latin1"));
  assert.equal(looksLikePdf(decoy), false);
});

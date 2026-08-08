import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import JSZip from "jszip";
import { generateDeliverable } from "@/lib/work/deliverables";
import type { DocumentSpec, PresentationSpec, SpreadsheetSpec } from "@/lib/work/deliverables";
import {
  WORK_KIND_FOR_OFFICE_FORMAT,
  exportVerificationMessage,
  verifyOfficeExport,
} from "@/lib/office-export-verify";

/*
 * Whether an exported artifact is checked before it is handed over.
 *
 * `/api/artifacts/[id]/export` built a Buffer and streamed it. A Buffer is not
 * evidence: a docx whose `word/document.xml` never got packed is a non-empty
 * zip with an Office content type on it, and it went out with a 200 and failed
 * on the reader's machine — after they had forwarded it. So the route now
 * re-opens what it built, with a reader that had no part in writing it, and
 * refuses instead of serving.
 *
 * Two things are worth pinning and they are different things.
 *
 *   1. The adapter answers correctly. Real bytes from the deliverable builders
 *      pass; the same bytes with the document part removed do not. This is
 *      where the format->kind mapping is exercised — `docx` validated as a
 *      spreadsheet would pass every structural check for the wrong reasons.
 *   2. The route actually calls it, and calls it BEFORE the response is
 *      constructed. A verifier nothing invokes is the state this file was
 *      written to end, and no behavioural assertion about a pure function can
 *      detect a return to it. That one is static, in the manner of
 *      `action-approval-enforcement.test.ts`.
 *
 * No database and no request context: the route's Prisma and session work is
 * not what regressed, and `src/lib/office-export-verify.ts` is deliberately
 * free of `server-only` so this file can import it at all.
 */

const DOCUMENT_SPEC: DocumentSpec = {
  kind: "document",
  title: "Q3 Supplier Review",
  blocks: [
    { type: "heading", level: 1, text: "Findings" },
    { type: "paragraph", text: "Unit cost fell 12% against Q2, entirely on freight." },
  ],
};

const SPREADSHEET_SPEC: SpreadsheetSpec = {
  kind: "spreadsheet",
  title: "Q3 Spend",
  sheets: [
    {
      name: "Summary",
      columns: [{ header: "Supplier", format: "text" }, { header: "Spend", format: "currency" }],
      rows: [["Meridian Freight", 48200]],
    },
  ],
};

const PRESENTATION_SPEC: PresentationSpec = {
  kind: "presentation",
  title: "Q3 Supplier Review",
  slides: [
    { layout: "title", title: "Q3 Supplier Review", subtitle: "Operations" },
    { layout: "bullets", title: "Findings", bullets: [{ text: "Freight is the whole delta" }] },
  ],
};

// ---------------------------------------------------------------------------
// 1. The adapter
// ---------------------------------------------------------------------------

test("every export format maps to the kind whose reader can actually open it", () => {
  assert.deepEqual(WORK_KIND_FOR_OFFICE_FORMAT, {
    docx: "document",
    xlsx: "spreadsheet",
    pptx: "presentation",
  });
});

test("a real file built by each builder passes the check", async () => {
  const cases = [
    { format: "docx", spec: DOCUMENT_SPEC },
    { format: "xlsx", spec: SPREADSHEET_SPEC },
    { format: "pptx", spec: PRESENTATION_SPEC },
  ] as const;

  for (const { format, spec } of cases) {
    const built = await generateDeliverable({ spec });
    const verdict = await verifyOfficeExport(format, built.bytes);
    assert.equal(verdict.ok, true, `${format} failed: ${verdict.problems.join(" ")}`);
    // The verdict has to say which build's rules cleared it — the route stamps
    // this onto the response, and a blank one there would be indistinguishable
    // from a deployment that never checked.
    assert.ok(verdict.validator.length > 0);
    assert.ok(verdict.observations.length > 0, `${format} was passed with no observation`);
  }
});

test("a docx that lost its document part is refused, not served", async () => {
  // Exactly what a builder that threw after packing the relationship parts
  // leaves behind: a zip a file manager labels a Word document, with nothing in
  // it for Word to open. The bytes are non-empty and the container is valid, so
  // every check short of re-opening it says this file is fine.
  const built = await generateDeliverable({ spec: DOCUMENT_SPEC });
  const zip = await JSZip.loadAsync(built.bytes);
  zip.remove("word/document.xml");
  const corrupt = await zip.generateAsync({ type: "nodebuffer" });

  assert.ok(corrupt.byteLength > 0, "the corrupt fixture must not be empty, or it proves nothing");

  const verdict = await verifyOfficeExport("docx", corrupt);
  assert.equal(verdict.ok, false);
  assert.ok(
    verdict.problems.some((problem) => problem.includes("word/document.xml")),
    `the missing document part was not named: ${verdict.problems.join(" ")}`
  );
});

test("a deck with its slides stripped out is refused", async () => {
  // pptxgenjs writes a structurally valid package when a deck ends up with no
  // slides, which is why the slide count is checked rather than assumed.
  const built = await generateDeliverable({ spec: PRESENTATION_SPEC });
  const zip = await JSZip.loadAsync(built.bytes);
  for (const name of Object.keys(zip.files)) {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) zip.remove(name);
  }
  const corrupt = await zip.generateAsync({ type: "nodebuffer" });

  const verdict = await verifyOfficeExport("pptx", corrupt);
  assert.equal(verdict.ok, false);
  assert.ok(
    verdict.problems.some((problem) => problem.includes("no slides")),
    `an empty deck was not refused: ${verdict.problems.join(" ")}`
  );
});

test("a workbook of arbitrary bytes fails rather than throwing out of the route", async () => {
  // The check has to answer, not explode: a validator that throws leaves the
  // caller unable to tell a broken file from a broken checker, and the route
  // would turn that into a 500 with no report attached.
  const verdict = await verifyOfficeExport("xlsx", Buffer.from("not a workbook at all"));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.length > 0);
});

test("the refusal message tells the user nothing was downloaded and names the format", () => {
  for (const format of ["docx", "xlsx", "pptx"] as const) {
    const message = exportVerificationMessage(format);
    assert.match(message, new RegExp(`\\.${format}\\b`));
    assert.match(message, /not (be )?download/i);
  }
});

// ---------------------------------------------------------------------------
// 2. The route calls it, before it answers
// ---------------------------------------------------------------------------

test("the export route verifies the buffer before it builds the response", () => {
  /*
   * Static, and it has to be. The regression this file exists for is not a
   * wrong answer from the verifier — it is the verifier not being reached, and
   * `buffer = await BUILDERS[format](...)` followed straight by
   * `new NextResponse(...)` passes every behavioural test that can be written
   * about a pure function. The ordering is the property: a check run after the
   * bytes are already in a 200 response is decoration.
   */
  const source = readFileSync(
    new URL("../src/app/api/artifacts/[id]/export/route.ts", import.meta.url),
    "utf8"
  );

  assert.match(
    source,
    /import\s*\{[^}]*verifyOfficeExport[^}]*\}\s*from\s*"@\/lib\/office-export-verify"/,
    "the export route no longer imports the verifier"
  );

  const verifyAt = source.indexOf("await verifyOfficeExport(");
  assert.notEqual(verifyAt, -1, "the export route no longer calls verifyOfficeExport");

  const streamAt = source.indexOf("new NextResponse(new Uint8Array(buffer)");
  assert.notEqual(streamAt, -1, "the export route no longer streams the buffer the way this asserts");
  assert.ok(verifyAt < streamAt, "verification runs after the file is already in the response");

  // And the failure branch refuses rather than falling through, keeping the
  // report with it — see the note on it in the route.
  const failure = source.slice(verifyAt, streamAt);
  assert.match(failure, /if\s*\(!verification\.ok\)/, "a failed verdict is not branched on");
  assert.match(failure, /return NextResponse\.json\([\s\S]*verification/, "the failed verdict is not returned");
  assert.match(failure, /status:\s*500/, "a corrupt file must not answer 200");
});

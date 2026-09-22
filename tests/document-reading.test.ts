import assert from "node:assert/strict";
import test from "node:test";
import {
  assembleDocumentText,
  documentOutline,
  type DocumentBlock,
} from "@/lib/knowledge/document-text";
import { matchAttachment, nameList } from "@/lib/agent/attachment-match";
import {
  sendableToolImages,
  toDataUrl,
  toolImageIntro,
  withheldImagesNote,
} from "@/lib/tool-result-images";

/*
 * How an indexed document is read back for a model.
 *
 * The claim under test is not "blocks join with newlines" — it is the thing
 * the whole change exists for: a model that is shown a document must be able
 * to say WHERE in it something was, and must be told when it is not being
 * shown all of it. Both are properties of the assembly, so both are testable
 * without a database.
 */

function block(partial: Partial<DocumentBlock> & { ordinal: number; text: string }): DocumentBlock {
  return { type: "paragraph", ...partial };
}

test("a document comes back in reading order with its page markers", () => {
  const assembled = assembleDocumentText([
    block({ ordinal: 2, text: "Second paragraph on page one.", page: 1 }),
    block({ ordinal: 0, text: "Annual Report", page: 1, type: "heading" }),
    block({ ordinal: 1, text: "First paragraph on page one.", page: 1 }),
    block({ ordinal: 3, text: "This one is on page two.", page: 2 }),
  ]);

  const text = assembled.text;
  // Ordinal, not array position: retrieval and the tool both hand back rows in
  // whatever order the query produced them.
  assert.ok(text.indexOf("Annual Report") < text.indexOf("First paragraph"));
  assert.ok(text.indexOf("First paragraph") < text.indexOf("Second paragraph"));
  assert.ok(text.indexOf("Second paragraph") < text.indexOf("page two"));

  assert.match(text, /\[page 1\]/);
  assert.match(text, /\[page 2\]/);
  // One marker per page, not one per block: a 40-paragraph page would
  // otherwise spend more of the budget on markers than on the page.
  assert.equal(text.match(/\[page 1\]/g)?.length, 1);
  assert.equal(assembled.truncated, false);
});

test("slides and sheets get their own locators", () => {
  const slides = assembleDocumentText([
    block({ ordinal: 0, text: "Roadmap", slide: 3, type: "slide_title" }),
    block({ ordinal: 1, text: "Ship in Q4", slide: 3 }),
  ]);
  assert.match(slides.text, /\[slide 3\]/);

  const sheet = assembleDocumentText([
    block({ ordinal: 0, text: "Revenue: 4.2M", sheet: "Q3", cellRange: "B7" }),
  ]);
  assert.match(sheet.text, /\[sheet Q3\]/);
});

test("a document cut by the budget stops at a block boundary and says so", () => {
  const blocks = Array.from({ length: 20 }, (_, i) =>
    block({ ordinal: i, text: `Paragraph ${i} ${"x".repeat(100)}`, page: 1 }),
  );
  const assembled = assembleDocumentText(blocks, { maxChars: 400 });

  assert.equal(assembled.truncated, true);
  assert.ok(assembled.blocksIncluded > 0, "something must come back");
  assert.ok(assembled.blocksIncluded < assembled.blocksTotal);
  assert.equal(assembled.blocksTotal, 20);
  assert.ok(assembled.text.length <= 400);
  /*
   * The cut lands BETWEEN blocks. A cut inside a paragraph produces a fragment
   * that reads as a complete statement and is not one, and a model has no way
   * to tell the difference — which is the whole reason the bound is applied
   * here rather than with a slice at the end.
   */
  const lastLine = assembled.text.trimEnd().split("\n").pop()!;
  assert.ok(
    blocks.some((candidate) => candidate.text === lastLine),
    `the last line must be a whole block, got: ${lastLine}`,
  );
  // The total counts every block, including the refused ones: otherwise
  // "you are seeing 40% of this" gets more confident the more it truncates.
  assert.ok(assembled.totalChars > assembled.text.length);
});

test("an empty document is empty rather than a marker", () => {
  const assembled = assembleDocumentText([]);
  assert.equal(assembled.text, "");
  assert.equal(assembled.blocksTotal, 0);
  assert.equal(assembled.truncated, false);
});

test("the outline is the headings, with where to find each one", () => {
  const outline = documentOutline([
    block({ ordinal: 0, text: "Introduction", page: 1, type: "heading" }),
    block({ ordinal: 1, text: "body text", page: 1 }),
    block({ ordinal: 2, text: "Indemnities", page: 14, type: "heading" }),
  ]);
  assert.deepEqual(outline, ["Introduction (page 1)", "Indemnities (page 14)"]);
});

/* -------------------------------------------------------------------------- */
/* Naming a file the way a model names one                                     */
/* -------------------------------------------------------------------------- */

const files = [
  { id: "att_1", fileName: "TD1.pdf" },
  { id: "att_2", fileName: "quarterly-report-2026.pdf" },
  { id: "att_3", fileName: "notes.txt" },
];

test("a file reference resolves from exact to forgiving", () => {
  assert.equal(matchAttachment(files, "att_2").match?.id, "att_2");
  assert.equal(matchAttachment(files, "TD1.pdf").match?.id, "att_1");
  // The name without its extension, which is how a model writes it back out
  // of its own prose.
  assert.equal(matchAttachment(files, "TD1").match?.id, "att_1");
  assert.equal(matchAttachment(files, "quarterly").match?.id, "att_2");
  assert.equal(matchAttachment(files, "td1.PDF").match?.id, "att_1");
});

test("an ambiguous reference resolves to nothing, not to a guess", () => {
  const twoPdfs = [
    { id: "a", fileName: "report-q1.pdf" },
    { id: "b", fileName: "report-q2.pdf" },
  ];
  const result = matchAttachment(twoPdfs, "report");
  assert.equal(result.match, null);
  assert.equal(result.ambiguous.length, 2);
  // Reading out the wrong document is a worse answer than asking which one,
  // so the caller gets the candidates to offer back.
  assert.match(nameList(result.ambiguous), /"report-q1\.pdf", "report-q2\.pdf"/);
});

test("no reference means the only file, or nothing at all", () => {
  assert.equal(matchAttachment([files[0]], undefined).match?.id, "att_1");
  assert.equal(matchAttachment(files, undefined).match, null);
  assert.equal(matchAttachment([], "anything").match, null);
});

/* -------------------------------------------------------------------------- */
/* Pixels coming back out of a tool                                            */
/* -------------------------------------------------------------------------- */

const jpeg = { mimeType: "image/jpeg", base64: "AAAA", label: "chart.png" };

test("tool images are withheld from a model that cannot see them", () => {
  assert.equal(sendableToolImages([jpeg], true).length, 1);
  assert.equal(sendableToolImages([jpeg], false).length, 0);
  // An unsupported codec is dropped rather than sent and rejected: a 400 from
  // the provider ends the whole turn, not just the picture.
  assert.equal(sendableToolImages([{ mimeType: "image/tiff", base64: "AAAA" }], true).length, 0);
  assert.equal(sendableToolImages([{ mimeType: "image/png", base64: "" }], true).length, 0);
  assert.equal(sendableToolImages(undefined, true).length, 0);
});

test("a withheld picture is admitted to, not passed over in silence", () => {
  const withheld = withheldImagesNote("Cropped it.", [jpeg], 0);
  assert.match(withheld, /could not be shown to you/);
  assert.match(withheld, /Do not describe detail you have not actually seen/);
  // Nothing added when everything was sent.
  assert.equal(withheldImagesNote("Cropped it.", [jpeg], 1), "Cropped it.");
  assert.equal(withheldImagesNote("Cropped it.", undefined, 0), "Cropped it.");
});

test("the follow-up turn says the picture came from a tool", () => {
  // Three of the four providers can only show a tool's image in a USER turn,
  // which on the wire is indistinguishable from an upload — so a model reading
  // it unannounced thanks the person for sending it.
  const intro = toolImageIntro("inspect_image", [jpeg]);
  assert.match(intro, /inspect_image/);
  assert.match(intro, /not something the user just sent/);
  assert.match(intro, /chart\.png/);
  assert.equal(toDataUrl(jpeg), "data:image/jpeg;base64,AAAA");
});

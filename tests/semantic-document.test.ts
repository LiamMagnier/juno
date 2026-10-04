import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { SemanticError } from "@/lib/work/deliverables/semantic/shared";
import {
  documentPlainText,
  normalizeDocument,
  outlineDocument,
  parseInline,
  runsToMarkup,
  serializeDocument,
  type DocumentModel,
} from "@/lib/work/deliverables/semantic/document/model";
import { applyDocumentOps } from "@/lib/work/deliverables/semantic/document/ops";
import { exportDocumentDocx, readDocumentDocx } from "@/lib/work/deliverables/semantic/document/docx-export";

const NOW = new Date("2026-10-04T12:00:00.000Z");
const PNG_1X1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function expectSemantic(fn: () => unknown, code: string, opIndex?: number): SemanticError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof SemanticError, `expected SemanticError, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    if (opIndex !== undefined) assert.equal(err.opIndex, opIndex);
    return err;
  }
  assert.fail("expected a SemanticError");
}

function sixBlocks(): DocumentModel {
  return normalizeDocument(
    {
      title: "Six",
      blocks: [
        { type: "heading", level: 1, text: "Six blocks" },
        { type: "paragraph", text: "One." },
        { type: "paragraph", text: "Two." },
        { type: "list", ordered: false, items: ["a", "b"] },
        { type: "table", header: ["k", "v"], rows: [["x", "1"]] },
        { type: "callout", tone: "note", text: "Note." },
      ],
    },
    { now: NOW }
  );
}

function richModel(): DocumentModel {
  return normalizeDocument(
    {
      title: "Market report 2026",
      metadata: {
        author: "Dana Reyes",
        subject: "Markets",
        description: "Quarterly market report",
        keywords: ["market", "growth"],
        language: "en-GB",
      },
      styles: { bodyFont: "Georgia", headingFont: "Inter", baseSizePt: 11, accent: "#3355AA" },
      sources: [
        { id: "s1", title: "Market census", url: "https://example.com/census", publisher: "Stats Office", accessed: "2026-09-01" },
        { id: "s2", title: "Field notes" },
      ],
      blocks: [
        { type: "heading", level: 1, text: "Market report" },
        { type: "paragraph", style: "lead", text: "The market grew **12%** in *2025* [@s1]." },
        { type: "heading", level: 2, text: "Findings" },
        { type: "paragraph", text: "See `docs` and [the site](https://example.com/a) for more [@s2]." },
        {
          type: "list",
          ordered: true,
          items: [
            { text: "First", level: 0 },
            { text: "Nested **bold**", level: 1 },
            { text: "Third", level: 0 },
          ],
        },
        { type: "list", ordered: false, items: ["Alpha", "Beta"] },
        { type: "table", header: ["Region", "Revenue"], rows: [["North", "10"], ["South", "12"]], caption: "Revenue by region" },
        { type: "table", header: ["Only"], rows: [["x"]] },
        { type: "callout", tone: "warning", title: "Heads up", text: "Numbers are *provisional*." },
        { type: "callout", tone: "tip", text: "Tip text" },
        { type: "figure", src: PNG_1X1, alt: "Chart of revenue", caption: "Figure 1", widthPct: 50 },
        { type: "figure", src: "https://example.com/remote.png", alt: "Remote image" },
        { type: "pageBreak" },
        { type: "paragraph", style: "quote", text: "A quoted line\nwith a break" },
        { type: "heading", level: 3, text: "Deep" },
        { type: "heading", level: 4, text: "Deeper" },
        { type: "paragraph", text: "Final paragraph." },
      ],
      comments: [
        { blockId: "b2", author: "Sam Lee", text: "Check this number", quote: "12%", createdAt: "2026-10-01T09:00:00Z" },
        { blockId: "b7", author: "Dana Reyes", text: "Looks right", resolved: true, createdAt: "2026-10-02T09:00:00Z" },
        { blockId: "b5", author: "Sam Lee", text: "Reorder?\nMaybe", createdAt: "2026-10-03T09:00:00Z" },
      ],
      revisions: [
        { blockId: "b4", kind: "replace", text: "See the **new** docs [@s2].", author: "Sam Lee", createdAt: "2026-10-03T10:00:00Z" },
        { blockId: "b9", kind: "insert", text: "Inserted *para*", author: "Dana Reyes", createdAt: "2026-10-03T11:00:00Z" },
        { blockId: "b17", kind: "delete", author: "Sam Lee", createdAt: "2026-10-03T12:00:00Z" },
        { blockId: "b2", kind: "replace", text: "Old history", status: "accepted", author: "Sam Lee", createdAt: "2026-09-01T00:00:00Z" },
      ],
    },
    { now: NOW }
  );
}

/** Ids replaced by positions, so a reopened file compares equal to the model it came from. */
function canonical(model: DocumentModel) {
  const blockIndex = new Map(model.blocks.map((block, index) => [block.id, index]));
  const sourceIndex = new Map(model.sources.map((source, index) => [source.id, index + 1]));
  const text = (value: string) =>
    runsToMarkup(parseInline(value).map((run) => (run.cite ? { text: "", cite: `S${sourceIndex.get(run.cite)}` } : run)));
  return {
    title: model.title,
    metadata: model.metadata,
    styles: model.styles,
    sources: model.sources.map(({ id: _id, ...rest }) => rest),
    blocks: model.blocks.map((block) => {
      const { id: _id, ...rest } = block;
      switch (rest.type) {
        case "heading":
        case "paragraph":
          return { ...rest, text: text(rest.text) };
        case "callout":
          return { ...rest, text: text(rest.text), ...(rest.title ? { title: text(rest.title) } : {}) };
        case "list":
          return { ...rest, items: rest.items.map((item) => ({ ...item, text: text(item.text) })) };
        case "table":
          return { ...rest, header: rest.header.map(text), rows: rest.rows.map((row) => row.map(text)) };
        default:
          return rest;
      }
    }),
    comments: model.comments.map(({ id: _id, blockId, ...rest }) => ({ ...rest, block: blockIndex.get(blockId) })),
    revisions: model.revisions
      .filter((revision) => revision.status === "pending")
      .map(({ id: _id, blockId, text: value, ...rest }) => ({ ...rest, text: text(value), block: blockIndex.get(blockId) ?? -1 }))
      // A file lists tracked changes in reading order; the model in the order they were made.
      .sort((a, b) => a.block - b.block || a.kind.localeCompare(b.kind) || a.text.localeCompare(b.text)),
  };
}

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

test("normalize assigns ids, defaults and keeps explicit ids", () => {
  const model = normalizeDocument(
    {
      title: "T",
      sources: [{ title: "A source" }],
      blocks: [
        { type: "heading", level: 2, text: "Hello" },
        { id: "intro", type: "paragraph", text: "Body [@src1]" },
        { type: "list", ordered: false, items: ["x", { text: "y", level: 1 }] },
      ],
      comments: [{ blockId: "intro", text: "Nice" }],
      revisions: [{ blockId: "intro", kind: "replace", text: "Better body" }],
    },
    { now: NOW }
  );
  assert.equal(model.kind, "document");
  assert.equal(model.version, 1);
  assert.deepEqual(
    model.blocks.map((block) => block.id),
    ["b1", "intro", "b2"]
  );
  assert.equal(model.sources[0].id, "src1");
  assert.equal(model.comments[0].id, "c1");
  assert.equal(model.comments[0].author, "Alevr");
  assert.equal(model.comments[0].createdAt, NOW.toISOString());
  assert.equal(model.revisions[0].id, "r1");
  assert.equal(model.revisions[0].status, "pending");
  assert.deepEqual(model.blocks[2], { id: "b2", type: "list", ordered: false, items: [{ text: "x", level: 0 }, { text: "y", level: 1 }] });
  // Normalizing a normalized model is the identity, and serialization is stable.
  assert.deepEqual(normalizeDocument(model), model);
  assert.equal(serializeDocument(normalizeDocument(JSON.parse(serializeDocument(model)))), serializeDocument(model));
});

test("normalize refuses ragged tables, unknown citations, unsafe images and dangling references", () => {
  const base = { title: "T" };
  const ragged = expectSemantic(
    () => normalizeDocument({ ...base, blocks: [{ type: "table", header: ["a", "b"], rows: [["1"]] }] }),
    "invalid_model"
  );
  assert.match(ragged.message, /row 1 has 1 cells but the header has 2/);
  expectSemantic(() => normalizeDocument({ ...base, blocks: [{ type: "paragraph", text: "x [@nope]" }] }), "invalid_model");
  for (const src of ["javascript:alert(1)", "http://example.com/a.png", "data:image/svg+xml;base64,PHN2Zz4=", "file:///etc/passwd"]) {
    expectSemantic(() => normalizeDocument({ ...base, blocks: [{ type: "figure", src, alt: "x" }] }), "invalid_model");
  }
  expectSemantic(
    () => normalizeDocument({ ...base, blocks: [{ type: "paragraph", text: "x" }], comments: [{ blockId: "b9", text: "?" }] }),
    "invalid_model"
  );
  expectSemantic(
    () => normalizeDocument({ ...base, blocks: [{ id: "x", type: "paragraph", text: "a" }, { id: "x", type: "paragraph", text: "b" }] }),
    "invalid_model"
  );
  expectSemantic(
    () => normalizeDocument({ ...base, blocks: [{ type: "table", header: ["a"], rows: [] }], revisions: [{ blockId: "b1", kind: "delete" }] }),
    "invalid_model"
  );
  expectSemantic(
    () => normalizeDocument({ ...base, blocks: Array.from({ length: 2001 }, () => ({ type: "pageBreak" })) }),
    "too_large"
  );
  expectSemantic(
    () => normalizeDocument({ ...base, blocks: [{ type: "table", header: ["a"], rows: Array.from({ length: 201 }, () => ["x"]) }] }),
    "invalid_model"
  );
  expectSemantic(() => normalizeDocument({ ...base, blocks: [{ type: "paragraph", text: "x".repeat(20_001) }] }), "invalid_model");
});

test("inline markup parses and writes back", () => {
  assert.deepEqual(parseInline("a **b** *c* `d` [e](https://x.test/) [@s1]"), [
    { text: "a " },
    { text: "b", bold: true },
    { text: " " },
    { text: "c", italic: true },
    { text: " " },
    { text: "d", code: true },
    { text: " " },
    { text: "e", link: "https://x.test/" },
    { text: " " },
    { text: "s1", cite: "s1" },
  ]);
  assert.deepEqual(parseInline("2 * 3 * 4"), [{ text: "2 * 3 * 4" }]);
  for (const sample of ["***x***", "**a***b*", "esc \\*not\\*", "C:\\path", "plain [brackets] here", "[**bold link**](https://x.test/a)"]) {
    assert.equal(runsToMarkup(parseInline(sample)), sample, sample);
  }
});

// ---------------------------------------------------------------------------
// ops
// ---------------------------------------------------------------------------

test("insertBlock, replaceBlock, updateText, moveBlock, deleteBlock", () => {
  const model = sixBlocks();
  const { model: next, changes } = applyDocumentOps(
    model,
    [
      { op: "insertBlock", after: null, block: { type: "paragraph", text: "Start" } },
      { op: "insertBlock", after: "b3", block: { type: "heading", level: 2, text: "Middle" } },
      { op: "replaceBlock", id: "b2", block: { type: "callout", tone: "tip", text: "Now a callout" } },
      { op: "updateText", id: "b1", text: "Renamed" },
      { op: "moveBlock", id: "b6", after: null },
      { op: "deleteBlock", id: "b5" },
    ],
    { now: NOW }
  );
  assert.deepEqual(
    next.blocks.map((block) => `${block.id}:${block.type}`),
    ["b6:callout", "b7:paragraph", "b1:heading", "b2:callout", "b3:paragraph", "b8:heading", "b4:list"]
  );
  assert.equal((next.blocks[2] as { text: string }).text, "Renamed");
  assert.equal(changes.length, 6);
  assert.equal(changes[1], "Inserted a heading (b8) after b3");
  assert.equal(changes[4], "Moved b6 at the start");
  // The input model is untouched.
  assert.deepEqual(model, sixBlocks());
});

test("ops refuse bad targets with a not_found or invalid_op and the failing index", () => {
  const model = sixBlocks();
  expectSemantic(() => applyDocumentOps(model, [{ op: "updateText", id: "b4", text: "x" }]), "invalid_op", 1);
  expectSemantic(() => applyDocumentOps(model, [{ op: "deleteBlock", id: "zz" }]), "not_found", 1);
  expectSemantic(() => applyDocumentOps(model, [{ op: "moveBlock", id: "b2", after: "b2" }]), "invalid_op", 1);
  expectSemantic(
    () => applyDocumentOps(model, [{ op: "replaceBlock", id: "b2", block: { id: "b3", type: "paragraph", text: "x" } }]),
    "invalid_op",
    1
  );
  expectSemantic(() => applyDocumentOps(model, [{ op: "suggestRevision", blockId: "b5", kind: "delete" }]), "invalid_op", 1);
  expectSemantic(() => applyDocumentOps(model, [{ op: "setStyles", styles: { accent: "blue" } }]), "invalid_op", 1);
  expectSemantic(() => applyDocumentOps(model, [{ op: "teleport" }]), "invalid_op", 1);
  expectSemantic(() => applyDocumentOps(model, []), "invalid_op");
});

test("a failing batch is all-or-nothing and reports the 1-based op index", () => {
  const model = sixBlocks();
  const before = structuredClone(model);
  expectSemantic(
    () =>
      applyDocumentOps(model, [
        { op: "updateText", id: "b2", text: "Changed" },
        { op: "comment", blockId: "b3", text: "ok" },
        { op: "insertBlock", after: "b2", block: { type: "paragraph", text: "cites [@missing]" } },
      ]),
    "invalid_model",
    3
  );
  assert.deepEqual(model, before);
  expectSemantic(
    () =>
      applyDocumentOps(model, [
        { op: "insertBlock", after: null, block: { type: "table", header: ["a", "b"], rows: [["1", "2", "3"]] } },
      ]),
    "invalid_model",
    1
  );
  assert.deepEqual(model, before);
});

test("an incremental edit changes only the targeted blocks", () => {
  const model = sixBlocks();
  const { model: next } = applyDocumentOps(
    model,
    [
      { op: "insertBlock", after: "b3", block: { type: "paragraph", text: "Inserted." } },
      { op: "updateText", id: "b2", text: "One, rewritten." },
      { op: "comment", blockId: "b5", text: "Check the table" },
      { op: "suggestRevision", blockId: "b6", kind: "replace", text: "Better note." },
    ],
    { now: NOW, author: "Riley" }
  );
  const byId = new Map(next.blocks.map((block) => [block.id, block]));
  for (const block of model.blocks) {
    if (block.id === "b2") assert.equal((byId.get("b2") as { text: string }).text, "One, rewritten.");
    else assert.deepEqual(byId.get(block.id), block, block.id);
  }
  assert.equal(next.blocks.length, 7);
  assert.equal(next.blocks[3].id, "b7");
  assert.deepEqual(next.comments, [{ id: "c1", blockId: "b5", author: "Riley", text: "Check the table", createdAt: NOW.toISOString() }]);
  assert.deepEqual(next.revisions, [
    { id: "r1", blockId: "b6", kind: "replace", text: "Better note.", author: "Riley", createdAt: NOW.toISOString(), status: "pending" },
  ]);
  // The suggestion does not change the block.
  assert.equal((byId.get("b6") as { text: string }).text, "Note.");
});

test("comments resolve; deleting a block removes its comments and changes", () => {
  const { model } = applyDocumentOps(
    sixBlocks(),
    [
      { op: "comment", blockId: "b2", text: "a", quote: "One" },
      { op: "comment", blockId: "b3", text: "b" },
      { op: "suggestRevision", blockId: "b2", kind: "replace", text: "Uno." },
      { op: "resolveComment", id: "c2" },
    ],
    { now: NOW }
  );
  assert.equal(model.comments.find((comment) => comment.id === "c2")?.resolved, true);
  expectSemantic(() => applyDocumentOps(model, [{ op: "resolveComment", id: "c9" }]), "not_found", 1);
  const { model: after, changes } = applyDocumentOps(model, [{ op: "deleteBlock", id: "b2" }]);
  assert.deepEqual(after.comments.map((comment) => comment.id), ["c2"]);
  assert.deepEqual(after.revisions, []);
  assert.match(changes[0], /Deleted a paragraph \(b2\)/);
});

test("accept and reject tracked changes", () => {
  const { model } = applyDocumentOps(
    sixBlocks(),
    [
      { op: "suggestRevision", blockId: "b2", kind: "replace", text: "One, better." },
      { op: "suggestRevision", blockId: "b3", kind: "insert", text: "New after two." },
      { op: "suggestRevision", blockId: "b6", kind: "delete" },
      { op: "suggestRevision", blockId: "b1", kind: "replace", text: "Rejected title" },
    ],
    { now: NOW }
  );
  expectSemantic(
    () => applyDocumentOps(model, [{ op: "suggestRevision", blockId: "b2", kind: "delete" }]),
    "invalid_op",
    1
  );
  const { model: next, changes } = applyDocumentOps(model, [
    { op: "acceptRevision", id: "r1" },
    { op: "acceptRevision", id: "r2" },
    { op: "acceptRevision", id: "r3" },
    { op: "rejectRevision", id: "r4" },
  ]);
  assert.deepEqual(
    next.blocks.map((block) => block.id),
    ["b1", "b2", "b3", "b7", "b4", "b5"]
  );
  assert.equal((next.blocks[1] as { text: string }).text, "One, better.");
  assert.deepEqual(next.blocks[3], { id: "b7", type: "paragraph", text: "New after two." });
  assert.equal((next.blocks[0] as { text: string }).text, "Six blocks");
  assert.deepEqual(
    next.revisions.map((revision) => `${revision.id}:${revision.status}`),
    ["r1:accepted", "r2:accepted", "r3:accepted", "r4:rejected"]
  );
  assert.equal(changes[2], "Accepted r3: deleted b6");
  expectSemantic(() => applyDocumentOps(next, [{ op: "acceptRevision", id: "r1" }]), "invalid_op", 1);
});

test("setMetadata, setStyles and addSource", () => {
  const { model } = applyDocumentOps(sixBlocks(), [
    { op: "setMetadata", metadata: { author: "Ana", keywords: ["x"] } },
    { op: "setStyles", styles: { accent: "#AA0000", baseSizePt: 12 } },
    { op: "addSource", source: { title: "A book", url: "https://books.test/1" } },
    { op: "updateText", id: "b2", text: "Cited [@src1]." },
    { op: "setMetadata", metadata: { keywords: null } },
  ]);
  assert.deepEqual(model.metadata, { author: "Ana" });
  assert.deepEqual(model.styles, { accent: "#aa0000", baseSizePt: 12 });
  assert.deepEqual(model.sources, [{ id: "src1", title: "A book", url: "https://books.test/1" }]);
});

// ---------------------------------------------------------------------------
// outline
// ---------------------------------------------------------------------------

test("the outline is addressable and bounded", () => {
  const model = richModel();
  const outline = outlineDocument(model);
  assert.match(outline, /^Document "Market report 2026": 17 blocks/);
  assert.match(outline, /^\[b1\] H1 Market report$/m);
  assert.match(outline, /^\[b2\] P\(lead\) The market grew/m);
  assert.match(outline, /^\[b7\] TABLE 2 cols × 2 rows caption: Revenue by region$/m);
  assert.match(outline, /^ {2}\| North \| 10 \|$/m);
  assert.match(outline, /^\[b9\] CALLOUT\(warning\) "Heads up"/m);
  assert.match(outline, /^\[b13\] PAGE BREAK$/m);
  assert.match(outline, /^\[c2\] on b7 by Dana Reyes \(resolved\): Looks right$/m);
  assert.match(outline, /^\[r1\] replace text of b4 with:/m);
  assert.doesNotMatch(outline, /\[r4\]/);

  const long = normalizeDocument({
    title: "Long",
    blocks: Array.from({ length: 500 }, (_, index) => ({ type: "paragraph", text: `Paragraph ${index} ${"word ".repeat(30)}` })),
  });
  const bounded = outlineDocument(long, 2_000);
  assert.ok(bounded.length <= 2_000, `outline is ${bounded.length} chars`);
  assert.match(bounded, /… \d+ more blocks$/);
  assert.ok(outlineDocument(long).length <= 12_000);

  const text = documentPlainText(model);
  assert.match(text, /The market grew 12% in 2025 \[@s1\]\./);
  assert.ok(!text.includes("**"));
});

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

test("the .docx export is a real Word package with comments, tracked changes and properties", async () => {
  const buffer = await exportDocumentDocx(richModel());
  const zip = await JSZip.loadAsync(buffer);
  const document = await zip.file("word/document.xml")!.async("string");
  const comments = await zip.file("word/comments.xml")!.async("string");
  const core = await zip.file("docProps/core.xml")!.async("string");
  const extended = await zip.file("word/commentsExtended.xml")?.async("string");
  const types = await zip.file("[Content_Types].xml")!.async("string");
  assert.match(core, /<dc:title>Market report 2026<\/dc:title>/);
  assert.match(core, /<dc:creator>Dana Reyes<\/dc:creator>/);
  assert.match(document, /<w:ins w:id="\d+" w:author="Sam Lee"/);
  assert.match(document, /<w:del w:id="\d+" w:author="Sam Lee"/);
  assert.match(document, /<w:delText[^>]*>Final paragraph\.<\/w:delText>/);
  assert.match(document, /<w:commentRangeStart w:id="0"\/>/);
  assert.match(document, /<w:pStyle w:val="Heading2"\/>/);
  assert.match(document, /<w:tblHeader\/>/);
  assert.match(document, /<w:numPr>/);
  assert.match(document, /<w:drawing>/);
  assert.match(document, /<w:br w:type="page"\/>/);
  assert.match(comments, /Check this number/);
  assert.match(comments, /w:author="Sam Lee"/);
  assert.ok(extended, "commentsExtended.xml carries the resolved state");
  assert.match(extended!, /w15:done="1"/);
  assert.match(types, /commentsExtended\+xml/);
  assert.doesNotMatch(document, /Old history/);
  assert.ok(Object.keys(zip.files).some((name) => name.startsWith("word/media/")));
});

test("export -> reopen restores the same document", async () => {
  const model = richModel();
  const reopened = await readDocumentDocx(await exportDocumentDocx(model));
  const expected = canonical(model);
  const actual = canonical(reopened);
  assert.deepEqual(actual.title, expected.title);
  assert.deepEqual(actual.metadata, expected.metadata);
  assert.deepEqual(actual.styles, expected.styles);
  assert.deepEqual(actual.sources, expected.sources);
  assert.equal(actual.blocks.length, expected.blocks.length);
  actual.blocks.forEach((block, index) => assert.deepEqual(block, expected.blocks[index], `block ${index}`));
  assert.deepEqual(actual.comments, expected.comments);
  assert.deepEqual(actual.revisions, expected.revisions);
  // The figure's image bytes come back as the same data URI.
  assert.equal((reopened.blocks[10] as { src: string }).src, PNG_1X1);
  assert.deepEqual(
    reopened.blocks.map((block) => block.id),
    model.blocks.map((_, index) => `b${index + 1}`)
  );
});

test("edit -> export -> reopen stays structurally equal", async () => {
  const reopened = await readDocumentDocx(await exportDocumentDocx(richModel()));
  const { model: edited } = applyDocumentOps(
    reopened,
    [
      { op: "updateText", id: "b3", text: "Findings, *revised*" },
      { op: "insertBlock", after: "b3", block: { type: "paragraph", text: "A new paragraph [@src1]." } },
      { op: "comment", blockId: "b3", text: "Renamed the section", author: "Riley" },
      { op: "acceptRevision", id: "r1" },
      { op: "suggestRevision", blockId: "b1", kind: "replace", text: "Market report, final", author: "Riley" },
      { op: "deleteBlock", id: "b13" },
    ],
    { now: NOW }
  );
  const again = await readDocumentDocx(await exportDocumentDocx(edited));
  assert.deepEqual(canonical(again), canonical(edited));
});

test("a plain model reopens with no invented styles or metadata", async () => {
  const model = normalizeDocument({ title: "Plain", blocks: [{ type: "paragraph", text: "Just text." }] });
  const reopened = await readDocumentDocx(await exportDocumentDocx(model));
  assert.deepEqual(reopened.styles, {});
  assert.deepEqual(reopened.metadata, {});
  assert.equal(reopened.title, "Plain");
  assert.deepEqual(canonical(reopened), canonical(model));
});

test("the reader refuses what is not a Word file", async () => {
  await assert.rejects(readDocumentDocx(Buffer.from("not a zip")), (err: unknown) => err instanceof SemanticError && err.code === "unreadable");
  const zip = new JSZip();
  zip.file("word/document.xml", '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><w:document/>');
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  await assert.rejects(readDocumentDocx(bytes), (err: unknown) => err instanceof SemanticError && err.code === "unreadable");
});

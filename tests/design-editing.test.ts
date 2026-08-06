/**
 * The editing rules a person notices when they are wrong.
 *
 * Everything here was a defect first: layers came back from a multi-layer undo
 * in the wrong order, an image layer could not be made at all, a document could
 * only ever have the page it was minted with, every gesture cost a permanent
 * copy of the document, and serif text was drawn wrapping somewhere other than
 * where it had been measured to wrap.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  allocatesCheckpoint,
  applyTransaction,
  coalesceOperations,
  CHECKPOINT_WINDOW_MS,
  DesignOperationError,
  invertTransaction,
  mintsIds,
  type DesignOperation,
  type DesignTransaction,
} from "../src/lib/design/operations";
import { measureText, wrapText } from "../src/lib/design/layout";
import { renderNodeSvg } from "../src/lib/design/render";
import { parseDesignDocument, validateHierarchy } from "../src/lib/design/schema";
import type { DesignDocument } from "../src/lib/design/types";
import { PAGE_ID, run, signInDocument, transaction } from "./design-fixtures";

/** Apply `operations` and then the inverse the result reported. */
function roundTrip(doc: DesignDocument, operations: DesignOperation[]) {
  const applied = run(doc, operations);
  const undone = applyTransaction(
    applied.document,
    invertTransaction(applied, transaction(operations, { baseRevision: doc.revision }), "2026-01-01T00:00:02.000Z")
  );
  return { applied, undone };
}

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const ASSET = { id: "asset1", kind: "image" as const, url: PIXEL, width: 1, height: 1, mimeType: "image/png" };

// ---------------------------------------------------------------------------
// Deleting more than one layer
// ---------------------------------------------------------------------------

test("undoing a multi-layer delete puts the layers back in their original order", () => {
  const doc = signInDocument();
  const before = ["title", "email", "button"];
  assert.deepEqual((doc.nodes["card"] as { children: string[] }).children, before);

  const { applied, undone } = roundTrip(doc, [{ op: "deleteNodes", nodeIds: before }]);
  assert.deepEqual((applied.document.nodes["card"] as { children: string[] }).children, []);
  assert.deepEqual(
    (undone.document.nodes["card"] as { children: string[] }).children,
    before,
    "z-order is part of the document, and undo has to hand it back unchanged"
  );
  assert.deepEqual(validateHierarchy(undone.document), []);
});

test("deleting a layer alongside one of its own descendants is not a failure", () => {
  const doc = signInDocument();
  const result = run(doc, [{ op: "deleteNodes", nodeIds: ["button", "buttonLabel"] }]);
  assert.equal(result.document.nodes["button"], undefined);
  assert.equal(result.document.nodes["buttonLabel"], undefined);
  assert.deepEqual(validateHierarchy(result.document), []);
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

test("a page can be added, renamed and deleted, and each inverts", () => {
  const doc = signInDocument();

  const added = run(doc, [{ op: "createPage", pageId: "page2", name: "Icons" }]).document;
  assert.deepEqual(added.pages.map((p) => p.id), [PAGE_ID, "page2"]);
  assert.equal(added.pages[1].name, "Icons");
  assert.deepEqual(added.pages[1].children, []);

  const renamed = run(added, [{ op: "renamePage", pageId: "page2", name: "Symbols" }]);
  assert.equal(renamed.document.pages[1].name, "Symbols");
  const unrenamed = applyTransaction(
    renamed.document,
    invertTransaction(renamed, transaction([], { baseRevision: added.revision }), "2026-01-01T00:00:02.000Z")
  );
  assert.equal(unrenamed.document.pages[1].name, "Icons");

  const { undone } = roundTrip(added, [{ op: "deletePage", pageId: "page2" }]);
  assert.deepEqual(undone.document.pages.map((p) => p.name), [added.pages[0].name, "Icons"]);
});

test("createPage honours an index, and a caller-chosen id cannot collide", () => {
  const doc = run(signInDocument(), [{ op: "createPage", pageId: "page2", name: "Second" }]).document;
  const inserted = run(doc, [{ op: "createPage", pageId: "page3", name: "First", index: 0 }]).document;
  assert.deepEqual(inserted.pages.map((p) => p.id), ["page3", PAGE_ID, "page2"]);

  assert.throws(
    () => run(inserted, [{ op: "createPage", pageId: "page2", name: "Again" }]),
    (error: unknown) => error instanceof DesignOperationError && error.code === "invalid"
  );
});

test("deleting a page takes its artwork with it, and undo brings all of it back", () => {
  const doc = run(signInDocument(), [{ op: "createPage", pageId: "page2", name: "Icons" }]).document;
  const withArt = run(doc, [
    { op: "createNode", parentId: null, pageId: "page2", node: { type: "frame", id: "iconFrame", name: "Icon" } },
    { op: "createNode", parentId: "iconFrame", pageId: "page2", node: { type: "ellipse", id: "iconDot", name: "Dot" } },
  ]).document;

  const { applied, undone } = roundTrip(withArt, [{ op: "deletePage", pageId: "page2" }]);
  assert.equal(applied.document.pages.length, 1);
  assert.equal(applied.document.nodes["iconFrame"], undefined);
  assert.equal(applied.document.nodes["iconDot"], undefined, "a page delete takes the whole subtree, not just its roots");

  assert.deepEqual(undone.document.pages.map((p) => p.id), [PAGE_ID, "page2"]);
  assert.deepEqual(undone.document.pages[1].children, ["iconFrame"]);
  assert.equal(undone.document.nodes["iconDot"].parentId, "iconFrame");
  assert.deepEqual(validateHierarchy(undone.document), []);
  // A restored page has to be a page the schema will read back.
  parseDesignDocument(JSON.parse(JSON.stringify(undone.document)));
});

test("the last page cannot be deleted", () => {
  assert.throws(
    () => run(signInDocument(), [{ op: "deletePage", pageId: PAGE_ID }]),
    (error: unknown) => error instanceof DesignOperationError && /at least one page/.test(error.message)
  );
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

test("an image layer is created with its asset, and neither can exist without the other", () => {
  const doc = signInDocument();

  assert.throws(
    () => run(doc, [{ op: "createNode", parentId: null, pageId: PAGE_ID, node: { type: "image" } }]),
    (error: unknown) => error instanceof DesignOperationError && /needs a picture/.test(error.message),
    "an image layer with no asset used to be refused by the node schema, in the schema's words"
  );

  assert.throws(
    () =>
      run(doc, [
        { op: "createNode", parentId: null, pageId: PAGE_ID, node: { type: "image", patch: { assetId: "nope" } } },
      ]),
    (error: unknown) => error instanceof DesignOperationError && error.code === "not-found"
  );

  const placed = run(doc, [
    { op: "createAsset", asset: ASSET },
    {
      op: "createNode",
      parentId: null,
      pageId: PAGE_ID,
      node: { type: "image", id: "photo", name: "Photo", patch: { assetId: ASSET.id, width: 120, height: 80 } },
    },
  ]);
  const photo = placed.document.nodes["photo"];
  assert.equal(photo.type === "image" && photo.assetId, ASSET.id);
  assert.equal(placed.document.assets[ASSET.id].url, PIXEL);

  // The renderer draws the picture rather than the placeholder it falls back to.
  const svg = renderNodeSvg(placed.document, "photo")!.svg;
  assert.ok(svg.includes("<image href=\"data:image/png;base64,"), "the asset is what makes the layer visible");
});

test("an asset round trips, and undo restores the picture a layer still points at", () => {
  const doc = run(signInDocument(), [
    { op: "createAsset", asset: ASSET },
    {
      op: "createNode",
      parentId: null,
      pageId: PAGE_ID,
      node: { type: "image", id: "photo", name: "Photo", patch: { assetId: ASSET.id } },
    },
  ]).document;

  const { applied, undone } = roundTrip(doc, [{ op: "deleteAsset", assetId: ASSET.id }]);
  assert.equal(applied.document.assets[ASSET.id], undefined);
  const orphan = applied.document.nodes["photo"];
  assert.equal(orphan.type === "image" && orphan.assetId, ASSET.id, "the layer keeps the reference; there is no empty asset id");
  assert.deepEqual(applied.touchedNodeIds, ["photo"], "the layer that lost its picture is what changed");
  assert.equal(undone.document.assets[ASSET.id].url, PIXEL);
});

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

test("coalescing keeps only the last of a run of updates to the same fields", () => {
  const operations: DesignOperation[] = [
    { op: "updateNode", nodeId: "button", patch: { x: 1, y: 1 } },
    { op: "updateNode", nodeId: "button", patch: { x: 2, y: 2 } },
    { op: "updateNode", nodeId: "title", patch: { x: 5, y: 5 } },
    { op: "updateNode", nodeId: "button", patch: { x: 3, y: 3 } },
  ];
  assert.deepEqual(coalesceOperations(operations), [
    { op: "updateNode", nodeId: "title", patch: { x: 5, y: 5 } },
    { op: "updateNode", nodeId: "button", patch: { x: 3, y: 3 } },
  ]);
});

test("coalescing never drops an update a later one does not fully replace", () => {
  const partial: DesignOperation[] = [
    { op: "updateNode", nodeId: "button", patch: { x: 1, y: 1 } },
    { op: "updateNode", nodeId: "button", patch: { x: 2 } },
  ];
  assert.equal(coalesceOperations(partial).length, 2, "the y from the first is still the y that stands");

  const acrossStructure: DesignOperation[] = [
    { op: "updateNode", nodeId: "button", patch: { x: 1 } },
    { op: "reorderNodes", nodeIds: ["button"], to: "front" },
    { op: "updateNode", nodeId: "button", patch: { x: 2 } },
  ];
  assert.equal(coalesceOperations(acrossStructure).length, 3, "only a run of plain field writes is safe to compress");
});

test("a coalesced batch produces the same document as the batch it replaces", () => {
  const doc = signInDocument();
  const operations: DesignOperation[] = [];
  for (let i = 1; i <= 40; i++) operations.push({ op: "updateNode", nodeId: "button", patch: { x: i, y: i * 2 } });

  const full = run(doc, operations).document;
  const compressed = run(doc, coalesceOperations(operations)).document;

  assert.equal(compressed.nodes["button"].x, 40);
  assert.deepEqual(compressed.nodes["button"], full.nodes["button"]);
  assert.equal(compressed.revision, full.revision, "compressing a batch is not a second change");
});

test("operations that mint ids are the ones a batch may not carry", () => {
  assert.equal(mintsIds([{ op: "updateNode", nodeId: "button", patch: { x: 1 } }]), false);
  assert.equal(
    mintsIds([{ op: "createNode", parentId: null, pageId: PAGE_ID, node: { type: "rectangle" } }]),
    true,
    "a drawn layer takes its id from the transaction it was applied under"
  );
  assert.equal(
    mintsIds([{ op: "createNode", parentId: null, pageId: PAGE_ID, node: { type: "rectangle", id: "given" } }]),
    false,
    "an id the caller chose travels with the operation and needs no seed"
  );
  assert.equal(mintsIds([{ op: "duplicateNodes", nodeIds: ["button"] }]), true);
  assert.equal(mintsIds([{ op: "groupNodes", nodeIds: ["title", "email"] }]), true);
  assert.equal(mintsIds([{ op: "groupNodes", nodeIds: ["title", "email"], groupId: "g1" }]), false);
  assert.equal(mintsIds([{ op: "createPage", name: "Untitled" }]), true);
  assert.equal(mintsIds([{ op: "createPage", pageId: "page2", name: "Untitled" }]), false);
});

test("the same operations under two transaction ids mint two different layers", () => {
  const doc = signInDocument();
  const operations: DesignOperation[] = [
    { op: "createNode", parentId: null, pageId: PAGE_ID, node: { type: "rectangle" } },
  ];
  const first = applyTransaction(doc, transaction(operations, { baseRevision: doc.revision, id: "tx-local" }));
  const second = applyTransaction(doc, transaction(operations, { baseRevision: doc.revision, id: "tx-batched" }));

  const idOf = (d: DesignDocument) => d.pages[0].children.at(-1);
  assert.notEqual(
    idOf(first.document),
    idOf(second.document),
    "batching these under a fresh id would leave the editor holding a layer the store has never named"
  );
});

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

test("a run of the user's own edits folds into one checkpoint", () => {
  const edit: DesignTransaction = transaction([{ op: "setSelection", nodeIds: [] }]);
  const fresh = { origin: "edit", ageMs: 1_000 };

  assert.equal(allocatesCheckpoint(null, edit, "edit"), true, "the first write has nothing to fold into");
  assert.equal(allocatesCheckpoint(fresh, edit, "edit"), false);
  assert.equal(allocatesCheckpoint({ origin: "edit", ageMs: CHECKPOINT_WINDOW_MS + 1 }, edit, "edit"), true);
  assert.equal(allocatesCheckpoint({ origin: "edit", ageMs: -5_000 }, edit, "edit"), true, "a clock disagreeing with itself takes the safe branch");
});

test("generated output, restore points and Juno's own changes are never folded over", () => {
  const edit = transaction([{ op: "setSelection", nodeIds: [] }]);
  const juno: DesignTransaction = { ...edit, author: "juno" };

  assert.equal(allocatesCheckpoint({ origin: "generated", ageMs: 10 }, edit, "edit"), true);
  assert.equal(allocatesCheckpoint({ origin: "restore", ageMs: 10 }, edit, "edit"), true);
  assert.equal(allocatesCheckpoint({ origin: null, ageMs: 10 }, edit, "edit"), true);
  assert.equal(allocatesCheckpoint({ origin: "edit", ageMs: 10 }, edit, "restore"), true);
  assert.equal(allocatesCheckpoint({ origin: "edit", ageMs: 10 }, juno, "edit"), true);
});

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

test("serif text is drawn breaking exactly where it was measured to break", () => {
  const characters = "the quick brown fox jumps over the lazy dog";
  const doc = run(signInDocument(), [
    {
      op: "updateNode",
      nodeId: "title",
      patch: {
        characters,
        // Georgia is measured at a narrower advance than the sans faces. The
        // renderer used to know about monospace and nothing else, so it drew
        // this sentence breaking a word earlier than it had been measured to.
        typography: { fontFamily: "Georgia", fontSize: 16 },
        widthMode: "fixed",
        width: 200,
      },
    },
  ]).document;

  const title = doc.nodes["title"];
  assert.equal(title.type, "text");
  if (title.type !== "text") return;

  const measured = wrapText(characters, title.typography, 200);
  const drawn = [...renderNodeSvg(doc, "title")!.svg.matchAll(/<tspan [^>]*>([^<]*)<\/tspan>/g)].map((m) => m[1]);

  assert.deepEqual(measured, ["the quick brown fox jumps", "over the lazy dog"]);
  assert.deepEqual(drawn, measured, "the measuring pass and the renderer share one advance model");
  assert.equal(measureText(characters, title.typography, 200).lines, measured.length);
});

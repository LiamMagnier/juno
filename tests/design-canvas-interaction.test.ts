/**
 * What a press on the canvas means.
 *
 * All of this was a defect first, and the same one twice over: the canvas asked
 * `hitTest` who was under the pointer and acted on the answer, but `hitTest`
 * answers with the *topmost* layer. With something selected and something else
 * overlapping on top of it, pressing inside your own selection re-picked the
 * layer on top and dragged that — "it moves the one on top, not the one you
 * selected". The rule is Figma's: a press inside the current selection drags the
 * current selection, and only a press outside it re-picks.
 *
 * The decision is a pure function so it can be checked here rather than by
 * hand, against real layout boxes rather than made-up rectangles — a rule about
 * where a press lands is only worth as much as the geometry it is tested on.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { canvasPress, pressLandsInSelection } from "../src/components/design/design-canvas";
import { layoutPage } from "../src/lib/design/layout";
import type { DesignDocument } from "../src/lib/design/types";
import { emptyDocument, PAGE_ID, run } from "./design-fixtures";

/**
 * Two overlapping siblings: `under` at 0,0 and `over` at 50,50, both 200×200.
 * They share the square between 50,50 and 200,200, and `over` is later in the
 * page's children, which makes it the topmost.
 */
function overlappingDocument(): DesignDocument {
  return run(emptyDocument(), [
    {
      op: "createNode",
      parentId: null,
      pageId: PAGE_ID,
      node: { type: "rectangle", id: "under", name: "Under", patch: { x: 0, y: 0, width: 200, height: 200 } },
    },
    {
      op: "createNode",
      parentId: null,
      pageId: PAGE_ID,
      node: { type: "rectangle", id: "over", name: "Over", patch: { x: 50, y: 50, width: 200, height: 200 } },
    },
  ]).document;
}

/** The point both rectangles contain. */
const SHARED = { x: 100, y: 100 };
/** Inside `under` only. */
const UNDER_ONLY = { x: 20, y: 20 };
/** Inside `over` only. */
const OVER_ONLY = { x: 230, y: 230 };

// ---------------------------------------------------------------------------
// Where the press landed
// ---------------------------------------------------------------------------

test("a press inside a selected layer counts as inside the selection even where another layer covers it", () => {
  const doc = overlappingDocument();
  const boxes = layoutPage(doc, PAGE_ID);
  assert.equal(pressLandsInSelection(SHARED, ["under"], boxes, doc), true);
  assert.equal(pressLandsInSelection(OVER_ONLY, ["under"], boxes, doc), false);
});

test("a locked or hidden layer is never something you can be pressing inside", () => {
  let doc = overlappingDocument();
  const boxes = layoutPage(doc, PAGE_ID);
  assert.equal(pressLandsInSelection(UNDER_ONLY, ["under"], boxes, doc), true);

  doc = run(doc, [{ op: "updateNode", nodeId: "under", patch: { visible: false } }]).document;
  assert.equal(
    pressLandsInSelection(UNDER_ONLY, ["under"], layoutPage(doc, PAGE_ID), doc),
    false,
    "hitTest skips hidden layers, so a press cannot be inside one either"
  );

  doc = run(doc, [{ op: "updateNode", nodeId: "under", patch: { visible: true } }]).document;
  doc = run(doc, [{ op: "updateNode", nodeId: "under", patch: { locked: true } }]).document;
  assert.equal(pressLandsInSelection(UNDER_ONLY, ["under"], layoutPage(doc, PAGE_ID), doc), false);
});

test("a selection id that is not on this page is simply not under the pointer", () => {
  const doc = overlappingDocument();
  const boxes = layoutPage(doc, PAGE_ID);
  assert.equal(pressLandsInSelection(SHARED, ["ghost"], boxes, doc), false);
});

// ---------------------------------------------------------------------------
// The rule itself
// ---------------------------------------------------------------------------

test("pressing inside the selection drags the selection instead of re-picking the layer on top", () => {
  // The reported defect, exactly: `under` is selected, `over` covers the point.
  const press = canvasPress({
    hit: "over",
    selection: ["under"],
    insideSelection: true,
    shiftKey: false,
    deepSelect: false,
  });
  assert.deepEqual(press, { kind: "move", select: null }, "select: null means keep what is selected and drag it");
});

test("pressing outside the selection re-picks", () => {
  assert.deepEqual(
    canvasPress({ hit: "over", selection: ["under"], insideSelection: false, shiftKey: false, deepSelect: false }),
    { kind: "move", select: ["over"] }
  );
});

test("a multi-selection survives a press on any one of its members", () => {
  assert.deepEqual(
    canvasPress({ hit: "over", selection: ["under", "over"], insideSelection: true, shiftKey: false, deepSelect: false }),
    { kind: "move", select: null },
    "pressing one of three selected layers has to drag all three, not collapse to one"
  );
});

test("⌘/Ctrl still deep-selects through a layer you already have selected", () => {
  // The override the whole rule needs: without it there would be no way to
  // reach a child of something that is selected.
  assert.deepEqual(
    canvasPress({ hit: "child", selection: ["parent"], insideSelection: true, shiftKey: false, deepSelect: true }),
    { kind: "move", select: ["child"] }
  );
});

test("⌘/Ctrl on something already selected keeps the selection rather than shrinking it", () => {
  assert.deepEqual(
    canvasPress({ hit: "over", selection: ["under", "over"], insideSelection: true, shiftKey: false, deepSelect: true }),
    { kind: "move", select: null }
  );
});

test("⌘/Ctrl on bare canvas is still a marquee", () => {
  assert.deepEqual(
    canvasPress({ hit: null, selection: ["under"], insideSelection: false, shiftKey: false, deepSelect: true }),
    { kind: "marquee", clear: true }
  );
});

test("shift toggles the layer under the pointer, inside the selection or out of it", () => {
  assert.deepEqual(
    canvasPress({ hit: "over", selection: ["under"], insideSelection: true, shiftKey: false, deepSelect: false }).kind,
    "move"
  );
  assert.deepEqual(
    canvasPress({ hit: "over", selection: ["under"], insideSelection: true, shiftKey: true, deepSelect: false }),
    { kind: "toggle", nodeId: "over" }
  );
  assert.deepEqual(
    canvasPress({ hit: "over", selection: ["under", "over"], insideSelection: true, shiftKey: true, deepSelect: false }),
    { kind: "toggle", nodeId: "over" }
  );
});

test("a shift-marquee adds to the selection; a plain one replaces it", () => {
  assert.deepEqual(
    canvasPress({ hit: null, selection: ["under"], insideSelection: false, shiftKey: true, deepSelect: false }),
    { kind: "marquee", clear: false }
  );
  assert.deepEqual(
    canvasPress({ hit: null, selection: ["under"], insideSelection: false, shiftKey: false, deepSelect: false }),
    { kind: "marquee", clear: true }
  );
});

test("a press inside the selection is a drag even when nothing can be hit-tested there", () => {
  // Reachable when the selected layer's only unlocked path was closed behind
  // it. Dragging what is selected is still the right answer; clearing the
  // selection because the hit test came back empty is not.
  assert.deepEqual(
    canvasPress({ hit: null, selection: ["under"], insideSelection: true, shiftKey: false, deepSelect: false }),
    { kind: "move", select: null }
  );
});

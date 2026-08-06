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
 * The second half is where a press *goes*: a click selected the outermost frame
 * and clicking again selected it a second time, so the only way to reach the
 * rectangle inside an iPhone frame was the layers panel. Descending is the same
 * shape of rule and gets the same treatment — pure functions over a real hit
 * path, checked here.
 *
 * The decision is a pure function so it can be checked here rather than by
 * hand, against real layout boxes rather than made-up rectangles — a rule about
 * where a press lands is only worth as much as the geometry it is tested on.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  canvasPress,
  descendSelection,
  doubleClickTarget,
  hitPath,
  pathHit,
  pressLandsInSelection,
} from "../src/components/design/design-canvas";
import { layoutPage } from "../src/lib/design/layout";
import type { DesignDocument } from "../src/lib/design/types";
import { emptyDocument, PAGE_ID, run, signInDocument } from "./design-fixtures";

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

// ---------------------------------------------------------------------------
// The chain under the pointer
// ---------------------------------------------------------------------------

/**
 * The sign-in fixture is four levels deep where it matters: the screen frame
 * holds a card, the card holds the button, and the button holds its label. Its
 * laid-out boxes put the label at 138,336 — 100×22 inside a 279×48 button — so
 * one point is genuinely inside all four.
 */
const LABEL_POINT = { x: 180, y: 345 };
/** Inside the card and the screen, but beside every child of the card. */
const CARD_GUTTER = { x: 32, y: 210 };
/** Inside the screen only. */
const SCREEN_ONLY = { x: 200, y: 700 };

function signInBoxes(doc: DesignDocument) {
  return layoutPage(doc, PAGE_ID);
}

test("the hit path is the whole chain under the pointer, outermost first", () => {
  const doc = signInDocument();
  assert.deepEqual(hitPath(LABEL_POINT, doc, PAGE_ID, signInBoxes(doc)), ["screen", "card", "button", "buttonLabel"]);
  assert.deepEqual(hitPath(CARD_GUTTER, doc, PAGE_ID, signInBoxes(doc)), ["screen", "card"]);
  assert.deepEqual(hitPath(SCREEN_ONLY, doc, PAGE_ID, signInBoxes(doc)), ["screen"]);
  assert.deepEqual(hitPath({ x: -20, y: -20 }, doc, PAGE_ID, signInBoxes(doc)), [], "bare canvas is an empty path");
});

test("the two ends of the path are the two selections the canvas already had", () => {
  const doc = signInDocument();
  const path = hitPath(LABEL_POINT, doc, PAGE_ID, signInBoxes(doc));
  assert.equal(pathHit(path, false), "screen", "a plain click still selects the outermost frame");
  assert.equal(pathHit(path, true), "buttonLabel", "⌘/Ctrl still jumps straight to the deepest layer");
  assert.equal(pathHit([], false), null);
  assert.equal(pathHit([], true), null);
});

test("a locked or hidden layer closes its whole subtree to the pointer", () => {
  let doc = signInDocument();
  doc = run(doc, [{ op: "updateNode", nodeId: "button", patch: { locked: true } }]).document;
  assert.deepEqual(
    hitPath(LABEL_POINT, doc, PAGE_ID, signInBoxes(doc)),
    ["screen", "card"],
    "a locked frame is not a lid you can reach the label through"
  );

  doc = signInDocument();
  doc = run(doc, [{ op: "updateNode", nodeId: "card", patch: { visible: false } }]).document;
  assert.deepEqual(hitPath(LABEL_POINT, doc, PAGE_ID, signInBoxes(doc)), ["screen"]);
});

// ---------------------------------------------------------------------------
// Clicking again goes deeper
// ---------------------------------------------------------------------------

const DEEP_PATH = ["screen", "card", "button", "buttonLabel"] as const;

test("repeated clicks walk down one level at a time", () => {
  // The reported defect: the first click gets the frame, and every click after
  // it used to get the frame again.
  const path = DEEP_PATH;
  assert.equal(descendSelection({ path, selection: ["screen"] }), "card");
  assert.equal(descendSelection({ path, selection: ["card"] }), "button");
  assert.equal(descendSelection({ path, selection: ["button"] }), "buttonLabel");
});

test("the walk stops at the layer under the cursor rather than looping", () => {
  assert.equal(
    descendSelection({ path: DEEP_PATH, selection: ["buttonLabel"] }),
    null,
    "nothing deeper is under the pointer, so the selection stays put"
  );
});

test("clicking another branch or bare canvas is not a descent", () => {
  assert.equal(
    descendSelection({ path: DEEP_PATH, selection: ["title"] }),
    null,
    "a sibling of the card is selected but is not under the pointer — pick normally, from the top"
  );
  assert.equal(descendSelection({ path: [], selection: ["card"] }), null, "bare canvas resets rather than descends");
  assert.equal(descendSelection({ path: DEEP_PATH, selection: [] }), null);
});

test("a descent advances one level however many ancestors are selected at once", () => {
  // Shift-clicking a frame and its child leaves both selected. Starting from
  // the shallower of the two would go back up a level on the next click.
  assert.equal(descendSelection({ path: DEEP_PATH, selection: ["screen", "card"] }), "button");
});

test("a descent is decided on the real geometry, not on a made-up path", () => {
  const doc = signInDocument();
  const path = hitPath(LABEL_POINT, doc, PAGE_ID, signInBoxes(doc));
  let selection: string[] = [];

  // First press: outside anything selected, so the press rule picks, and it
  // picks the outermost frame.
  const press = canvasPress({ hit: pathHit(path, false), selection, insideSelection: false, shiftKey: false, deepSelect: false });
  assert.deepEqual(press, { kind: "move", select: ["screen"] });
  selection = press.select ?? selection;

  // Every click after it is inside the selection, so the press rule keeps the
  // drag and the release descends.
  const walked: string[] = [];
  for (let i = 0; i < 5; i++) {
    const next = descendSelection({ path, selection });
    if (next === null) break;
    walked.push(next);
    selection = [next];
  }
  assert.deepEqual(walked, ["card", "button", "buttonLabel"], "three more clicks reach the label and then stop");
});

test("a press inside the selection is still a drag while it is also a candidate descent", () => {
  // The two rules have to hold at once: the press-down answer is unchanged, and
  // the descent is spent on the release only if nothing moved.
  assert.deepEqual(
    canvasPress({ hit: "screen", selection: ["screen"], insideSelection: true, shiftKey: false, deepSelect: false }),
    { kind: "move", select: null }
  );
});

test("a double-click reads where its own two clicks landed rather than descending again", () => {
  // Measured, not assumed: `detail` on a pointer-up is 0 in Chromium, so there
  // is no way to tell the second release of a double-click from any other
  // release — and no need to. Both releases descend, and the gesture that
  // follows them only reads the result. Descending here too would move three
  // levels for one double-click.
  assert.equal(doubleClickTarget({ path: DEEP_PATH, selection: ["button"] }), "button");
  assert.equal(doubleClickTarget({ path: DEEP_PATH, selection: ["buttonLabel"] }), "buttonLabel");
  assert.equal(
    doubleClickTarget({ path: DEEP_PATH, selection: ["screen", "button"] }),
    "button",
    "the deepest selected layer under the cursor, so an outer frame left selected does not win"
  );
});

test("a double-click on something outside the selection acts on nothing", () => {
  assert.equal(doubleClickTarget({ path: DEEP_PATH, selection: ["title"] }), null);
  assert.equal(doubleClickTarget({ path: [], selection: ["card"] }), null);
  assert.equal(doubleClickTarget({ path: DEEP_PATH, selection: [] }), null);
});

test("double-clicking a text layer that sits in a frame still puts a caret in it", () => {
  // This is how a caption is edited and it has to keep working: the first click
  // takes the frame, the second descends to the text, and the gesture finds it
  // selected and under the cursor.
  const path = ["screen", "title"] as const;
  assert.equal(descendSelection({ path, selection: ["screen"] }), "title");
  assert.equal(doubleClickTarget({ path, selection: ["title"] }), "title");
  assert.equal(doubleClickTarget({ path: ["title"], selection: ["title"] }), "title", "a top-level text layer is its own path");
});

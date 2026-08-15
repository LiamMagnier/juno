/**
 * The editor shell's own decisions.
 *
 * Two things moved out of constants and into the user's hands in this pass, and
 * both have a rule underneath them that is easy to get backwards and impossible
 * to see in review:
 *
 *  - **Pane sizing.** The three panes were `w-52` / `w-64` / `height: 244`. A
 *    grip on the layers rail's RIGHT edge grows the rail when the pointer moves
 *    right; a grip on the inspector's LEFT edge shrinks it on the same move; the
 *    timeline's grip is on its top edge and grows upwards. One sign, three
 *    answers — checked here rather than by dragging.
 *  - **Retyping a variable.** `type` and the `kind` of each `valuesByMode` entry
 *    are separate fields, so converting only the mode on screen leaves a legal
 *    document that resolves to a colour in one mode and a number in another.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  PANE_BOUNDS,
  clampPaneSize,
  paneSizeFromDrag,
  paneSizeFromKey,
} from "../src/components/design/panel-layout";
import { nextVariableName, retypedVariable } from "../src/components/design/layers-panel";
import { resolveVariable } from "../src/lib/design/variables";
import { emptyDocument, run, withTokens } from "./design-fixtures";
import type { DesignVariable } from "../src/lib/design/types";

// ---------------------------------------------------------------------------
// Pane sizing
// ---------------------------------------------------------------------------

test("a drag grows the pane its grip belongs to, whichever edge that is", () => {
  const layers = PANE_BOUNDS.layers;
  const inspector = PANE_BOUNDS.inspector;
  const timeline = PANE_BOUNDS.timeline;

  // Starting sizes are chosen clear of the bounds so the sign, not the clamp,
  // is what these read.

  // Left rail, grip on the right edge: rightwards is wider.
  assert.equal(paneSizeFromDrag("start", 268, 400, 460, layers), 328);
  assert.equal(paneSizeFromDrag("start", 268, 400, 340, layers), 208);

  // Right rail, grip on the left edge: rightwards is NARROWER. This is the one
  // that ships inverted.
  assert.equal(paneSizeFromDrag("end", 320, 900, 960, inspector), 260);
  assert.equal(paneSizeFromDrag("end", 320, 900, 840, inspector), 380);

  // Timeline, grip on the top edge: upwards (a smaller clientY) is taller.
  assert.equal(paneSizeFromDrag("top", 244, 700, 640, timeline), 304);
  assert.equal(paneSizeFromDrag("top", 244, 700, 760, timeline), 184);
});

test("a pane cannot be dragged out of existence, or past the canvas", () => {
  const layers = PANE_BOUNDS.layers;
  // A drag far past the minimum stops at the minimum rather than collapsing —
  // collapsing is a separate, labelled, reversible gesture.
  assert.equal(paneSizeFromDrag("start", 208, 400, -4_000, layers), layers.min);
  assert.equal(paneSizeFromDrag("start", 208, 400, 4_000, layers), layers.max);
  // A stored value from a build whose bounds have since moved is clamped, and a
  // corrupt one falls back to the default rather than producing a NaN width.
  assert.equal(clampPaneSize(10_000, layers), layers.max);
  assert.equal(clampPaneSize(Number.NaN, layers), layers.initial);
  assert.equal(clampPaneSize(220.6, layers), 221);
});

test("arrow keys resize in the direction the same drag would", () => {
  const layers = PANE_BOUNDS.layers;
  const inspector = PANE_BOUNDS.inspector;

  assert.equal(paneSizeFromKey("start", 208, "ArrowRight", false, layers), 216);
  assert.equal(paneSizeFromKey("start", 208, "ArrowLeft", false, layers), 200);
  assert.equal(paneSizeFromKey("start", 208, "ArrowRight", true, layers), 240, "shift is the coarse step");

  // Mirrored, exactly as the drag is.
  assert.equal(paneSizeFromKey("end", 256, "ArrowRight", false, inspector), 248);
  assert.equal(paneSizeFromKey("end", 256, "ArrowLeft", false, inspector), 264);

  assert.equal(paneSizeFromKey("start", 300, "Home", false, layers), layers.initial);
  // A key this grip has no answer for is left to whatever else wants it.
  assert.equal(paneSizeFromKey("start", 208, "a", false, layers), null);
  assert.equal(paneSizeFromKey("start", 208, "Enter", false, layers), null);
});

test("every pane's default sits inside its own bounds", () => {
  for (const [name, bounds] of Object.entries(PANE_BOUNDS)) {
    assert.ok(bounds.min <= bounds.initial, `${name}: default is below its minimum`);
    assert.ok(bounds.initial <= bounds.max, `${name}: default is above its maximum`);
  }
});

// ---------------------------------------------------------------------------
// Variable authoring
// ---------------------------------------------------------------------------

test("retyping a variable rewrites every mode, not the one on screen", () => {
  const doc = withTokens(emptyDocument());
  const primary = doc.variables["var-primary"];
  assert.equal(Object.keys(primary.valuesByMode).length, 2, "the fixture declares both modes");

  const retyped = retypedVariable(primary, "number");
  assert.equal(retyped.type, "number");
  for (const [mode, entry] of Object.entries(retyped.valuesByMode)) {
    assert.equal(entry.kind, "number", `${mode} still holds the old kind`);
  }

  // And the retyped variable is a document the operation layer accepts, whose
  // value resolves as the new type in the active mode.
  const next = run(doc, [{ op: "createVariable", variable: retyped }]).document;
  const resolved = resolveVariable(next, "var-primary");
  assert.ok(resolved.ok);
  assert.equal(resolved.type, "number");
  assert.equal(typeof resolved.value, "number");
});

test("retyping to the same type is not an edit", () => {
  const primary = withTokens(emptyDocument()).variables["var-primary"];
  assert.equal(retypedVariable(primary, "color"), primary, "the identity is what the caller tests to skip the write");
});

test("a new variable never reuses a name already in the library", () => {
  assert.equal(nextVariableName([], 0), "token-1");
  assert.equal(nextVariableName(["token-1"], 1), "token-2");
  // Deleting the middle of a run: the count says 2, but token-3 is taken.
  assert.equal(nextVariableName(["token-1", "token-3"], 2), "token-4");
  assert.equal(nextVariableName(["token-1", "token-2", "token-3"], 1), "token-4");
});

test("editing a variable through createVariable is one undoable step", () => {
  // The whole authoring UI writes edits as `createVariable` carrying the entire
  // variable, because the operation is an upsert whose inverse is the variable
  // as it was. If that ever stopped being true, rename and retype would become
  // un-undoable without anything else failing.
  const doc = withTokens(emptyDocument());
  const renamed: DesignVariable = { ...doc.variables["var-primary"], name: "brand" };
  const result = run(doc, [{ op: "createVariable", variable: renamed }]);
  assert.equal(result.document.variables["var-primary"].name, "brand");

  const back = run(result.document, result.inverse);
  assert.equal(back.document.variables["var-primary"].name, "primary");
  assert.equal(Object.keys(back.document.variables).length, Object.keys(doc.variables).length);
});

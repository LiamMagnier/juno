import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { splitBounds } from "../src/hooks/use-split-pane";
import {
  CANVAS_MIN_WIDTH,
  CHAT_MIN_WIDTH,
  SPLIT_MIN_WIDTH,
  THOUGHT_DEFAULT_WIDTH,
  canvasWidthBounds,
  splitEngaged,
  thoughtWidthBounds,
} from "../src/components/chat/split-layout";

/*
 * THE SPLIT'S ARITHMETIC, PINNED AT THE SEAMS.
 *
 * Two halves decide whether a docked column sits beside a transcript or covers
 * it: the CSS (`@[50rem]/split:` in the class strings) and the code
 * (`splitEngaged`, SPLIT_MIN_WIDTH). They are written in different units in
 * different files, and the failure this guards against is the one that
 * shipped: `lg:` in one file and `matchMedia("(max-width: 1023px)")` in
 * another, both keyed to a window the page does not have, so the transcript
 * rendered at 239px under a 320px floor that only ever governed the drag.
 *
 * The class strings are read as SOURCE, the way tests/code-rollback.test.ts
 * reads its route guards: the facts worth pinning are relationships BETWEEN
 * files, and the components themselves cannot be imported by a test process.
 */

const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
/* The class strings are in rem and the code is in px; they agree at the 16px
 * root every width in split-layout.ts assumes. */
const ROOT_PX = 16;
const remOf = (px: number) => `${px / ROOT_PX}rem`;
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const containerSteps = (src: string, name: string) =>
  [...new Set([...src.matchAll(new RegExp(`@\\[([\\d.]+rem)\\]/${name}:`, "g"))].map((m) => m[1]))].sort();

test("the split engages exactly where an undragged dock leaves the transcript its floor", () => {
  assert.equal(SPLIT_MIN_WIDTH, CHAT_MIN_WIDTH + THOUGHT_DEFAULT_WIDTH);

  // At the switch point the dock's CSS default is reachable (the handle does
  // not lie) and the chat keeps exactly its floor beside it.
  const dock = thoughtWidthBounds(SPLIT_MIN_WIDTH);
  assert.ok(dock.maxWidth >= THOUGHT_DEFAULT_WIDTH, "the dock's default width must be reachable at the split");
  assert.equal(SPLIT_MIN_WIDTH - dock.maxWidth, CHAT_MIN_WIDTH);

  // The canvas shares the switch point: its own minimum fits, and no width in
  // its range can push the chat under the floor.
  const canvas = canvasWidthBounds(SPLIT_MIN_WIDTH);
  assert.ok(canvas.minWidth >= CANVAS_MIN_WIDTH, "the canvas is not squeezed below its minimum at the split");
  assert.ok(SPLIT_MIN_WIDTH - canvas.maxWidth >= CHAT_MIN_WIDTH);
});

test("splitEngaged reads the mount, not the window", () => {
  const mount = (width: number) => ({ getBoundingClientRect: () => ({ width }) as DOMRect });
  assert.equal(splitEngaged(null), false, "no mount yet reads as not split");
  assert.equal(splitEngaged(mount(SPLIT_MIN_WIDTH - 1)), false);
  assert.equal(splitEngaged(mount(SPLIT_MIN_WIDTH)), true);
  // The case that shipped: a 1024px window, which `lg:` called split, with the
  // sidebar's 304px out of it.
  assert.equal(splitEngaged(mount(1024 - 304)), false);
});

test("every @[…]/split: step in the chat surfaces is the split's own number", () => {
  for (const rel of [
    "src/components/chat/chat-view.tsx",
    "src/components/chat/thought-process-panel.tsx",
    "src/components/canvas/canvas-panel.tsx",
  ]) {
    const src = read(rel);
    assert.deepEqual(containerSteps(src, "split"), [remOf(SPLIT_MIN_WIDTH)], rel);
    assert.ok(!/\blg:/.test(stripComments(src)), `${rel} still keys a class on the window`);
    assert.ok(!src.includes("(max-width: 1023px)"), `${rel} still gates the split on the window`);
  }
});

test("the code session's docks each derive their step from their width plus the floor", () => {
  const src = read("src/components/code/code-session-view.tsx");
  const canvasStep = CHAT_MIN_WIDTH + 34 * ROOT_PX;
  assert.deepEqual(containerSteps(src, "split"), [remOf(SPLIT_MIN_WIDTH), remOf(canvasStep)].sort());
  assert.match(src, /@\[54rem\]\/split:w-\[34rem\]/, "the 34rem canvas engages at its own step");
  assert.match(src, /@\[50rem\]\/split:w-\[30rem\]/, "the 30rem dock engages at the shared one");
  assert.ok(!/\blg:/.test(stripComments(src)));
  assert.ok(!src.includes("(max-width: 1023px)"));
});

test("the Work thread's split is the file's own floor plus its narrowest rail", () => {
  const src = read("src/app/(app)/work/[id]/page.tsx");
  const floor = src.match(/const WORK_CONVERSATION_MIN_WIDTH = (\d+) \+ (\d+);/);
  const rail = src.match(/const WORK_RAIL_DEFAULT_WIDTH = (\d+);/);
  const railMax = src.match(/const WORK_RAIL_CSS_WIDTH = (\d+);/);
  const share = src.match(/const WORK_RAIL_SHARE = 0\.(\d+);/);
  assert.ok(floor && rail && railMax && share, "the constants the thresholds derive from are still declared");
  const splitAt = Number(floor[1]) + Number(floor[2]) + Number(rail[1]);
  assert.deepEqual(containerSteps(src, "thread"), [remOf(splitAt)]);
  // The undragged rail is a share of the grid between the two rem values the
  // constants name — no second step, so the conversation never narrows as the
  // grid widens. The class is matched as `clamp(<min>,<share>%,<max>)` with no
  // spaces, which is how the page writes it; a rewrite that spells the share
  // differently (a custom property, a `min()`) has to update this line too.
  assert.match(src, new RegExp(`clamp\\(${remOf(Number(rail[1]))},${share[1]}%,${remOf(Number(railMax[1]))}\\)`));
  // At the split the CSS draws the rail at its narrowest, and the bounds must
  // say so: a `cssWidth` fixed at the top of the clamp kept 416 reachable
  // there, so a drag left the conversation 456 wide under a 520 floor.
  const primaryMin = Number(floor[1]) + Number(floor[2]);
  const cssAt = (w: number) =>
    Math.min(Number(railMax[1]), Math.max(Number(rail[1]), Math.round(w * Number(`0.${share[1]}`))));
  const atSplit = splitBounds({
    containerWidth: splitAt,
    paneMin: 288,
    paneFloor: 240,
    primaryMin,
    fraction: 0.5,
    cssWidth: cssAt(splitAt),
  });
  assert.equal(atSplit.maxWidth, Number(rail[1]), "the rail's max at the split is its CSS width");
  assert.equal(splitAt - atSplit.maxWidth, primaryMin, "the conversation keeps its floor at the split");
  const code = stripComments(src);
  assert.ok(!/\b(lg|xl):/.test(code), "the grid still keys a class on the window");
  assert.ok(!src.includes("(max-width: 1023px)"));
});

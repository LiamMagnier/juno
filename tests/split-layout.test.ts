import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

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
  // The review dock is the third column, and it is sized by the same equation
  // rather than by eye: 32rem of unified diff on top of the transcript's floor.
  // If someone widens the pane without moving its step, the transcript goes
  // under 320px while both are on screen — which is the whole failure this
  // derivation exists to make impossible.
  const reviewStep = CHAT_MIN_WIDTH + 32 * ROOT_PX;
  assert.deepEqual(
    containerSteps(src, "split"),
    [remOf(SPLIT_MIN_WIDTH), remOf(reviewStep), remOf(canvasStep)].sort(),
  );
  assert.match(src, /@\[54rem\]\/split:w-\[34rem\]/, "the 34rem canvas engages at its own step");
  assert.match(src, /@\[52rem\]\/split:w-\[32rem\]/, "the 32rem review dock engages at its own step");
  assert.match(src, /@\[50rem\]\/split:w-\[30rem\]/, "the 30rem dock engages at the shared one");
  assert.ok(!/\blg:/.test(stripComments(src)));
  assert.ok(!src.includes("(max-width: 1023px)"));
});

/*
 * THE WORK THREAD'S SPLIT IS NOT PINNED HERE ANY MORE, because there is no
 * longer a split to pin. `src/app/(app)/work/[id]/page.tsx` drew a conversation
 * beside a rail of run detail, and its four constants —
 * WORK_CONVERSATION_MIN_WIDTH, WORK_RAIL_DEFAULT_WIDTH, WORK_RAIL_CSS_WIDTH,
 * WORK_RAIL_SHARE — were the numbers this file checked the page's own
 * `@[...]/thread:` classes against. A delegated run is now drawn INSIDE the
 * transcript (docs/design/TWO_PRODUCTS.md §3): `WorkRunPanel` is a block in the
 * reading column, it has no second column and therefore no threshold at which
 * one appears, and the two splits that remain — the chat's docks and the code
 * session's — are covered by the tests above. The test was deleted rather than
 * retargeted because there is nothing left for it to be retargeted AT.
 */

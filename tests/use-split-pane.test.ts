import assert from "node:assert/strict";
import test from "node:test";

import { observedInlineSize } from "../src/hooks/use-split-pane";

/*
 * The split-pane hook re-measures on a ResizeObserver, and the observer also
 * fires when only the block size changed — which, for the Work grid below its
 * split, is every streamed line. The hook skips those by comparing the inline
 * size the entry reports; this pins how that size is read, since the hook
 * itself cannot run outside a renderer.
 */

type Entry = Parameters<typeof observedInlineSize>[0][number];
const entry = (inlineSize: number, blockSize: number, width = inlineSize): Entry => ({
  contentBoxSize: [{ inlineSize, blockSize }],
  contentRect: { width, height: blockSize } as DOMRectReadOnly,
});

test("a block-size-only resize reports the inline size it already had", () => {
  const before = observedInlineSize([entry(872, 400)]);
  const after = observedInlineSize([entry(872, 1200)]);
  assert.equal(before, 872);
  assert.equal(after, before, "the hook compares these and must see no change");
  assert.notEqual(observedInlineSize([entry(632, 1200)]), before, "a real width change still reads as one");
});

test("contentBoxSize wins over contentRect, and contentRect stands in when it is absent", () => {
  // The two disagree by the box's padding; the spec box is the one the
  // container queries measure.
  assert.equal(observedInlineSize([entry(800, 10, 832)]), 800);
  const legacy = { contentBoxSize: undefined, contentRect: { width: 832 } } as unknown as Entry;
  assert.equal(observedInlineSize([legacy]), 832);
});

test("an empty callback reads as unknown rather than unchanged", () => {
  assert.equal(observedInlineSize([]), null);
});

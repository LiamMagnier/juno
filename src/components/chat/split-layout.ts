import { splitBounds } from "@/hooks/use-split-pane";

/*
 * THE SPLIT IS DECIDED BY THE CHAT MOUNT, NOT BY THE WINDOW.
 *
 * Chat is a primary column with, at most, one docked column beside it — the
 * canvas or the thought dock. Whether the two fit side by side is a question
 * about the width of the box they share and nothing else, and for a long time
 * it was answered by the window: `lg:` in the class strings and
 * `matchMedia("(max-width: 1023px)")` in the code, both keyed to a 1024px
 * viewport. A page inside the shell does not have the window
 * (docs/design/PREMIUM_AUDIT.md rule 11). With the sidebar expanded a 1024px
 * window leaves the chat 720px, so a split there put the dock's 480 beside a
 * 239px transcript — under the 320 floor `CHAT_MIN_WIDTH` declares and the drag
 * bounds below enforce. The bounds only ever governed the DRAG; whether to
 * split at all was decided by a breakpoint that never looked at the mount.
 *
 * The mount is a `@container/split` now, and both halves read it: the CSS
 * through `@[50rem]/split:`, the code through `splitEngaged()`. The number is
 * derived rather than chosen — the split engages exactly where an undragged
 * dock leaves the transcript its floor — and it is written as a rem in the
 * class strings and as pixels here, which agree at the 16px root every other
 * width in this file assumes. tests/split-layout.test.ts pins the two to each
 * other so neither can move alone.
 *
 * A module of its own so that test can import it: chat-view.tsx is the whole
 * client surface.
 */

export const CANVAS_MIN_WIDTH = 420;
export const CHAT_MIN_WIDTH = 320;

export function canvasWidthBounds(containerWidth: number) {
  return splitBounds({
    containerWidth,
    paneMin: CANVAS_MIN_WIDTH,
    // 320 in its own right, not CHAT_MIN_WIDTH reused: this is how far the
    // canvas itself may be squeezed on a container that cannot give both
    // columns what they want, and the two numbers coinciding is arithmetic
    // rather than a shared rule.
    paneFloor: 320,
    primaryMin: CHAT_MIN_WIDTH,
    fraction: 0.82,
  });
}

/* ─── Thought dock width ──────────────────────────────────────────────────────
 * The dock shipped as a fixed column on the reasoning that it "holds one
 * fixed-measure column of receipts" and so had not earned a handle. Overruled:
 * the user wants the control, in both directions, at any time.
 *
 * Deliberately its own key and its own bounds, but the SAME mechanism as the
 * canvas — pointer capture, cursor/user-select save-restore, clamp-on-restore.
 *
 * THE DEFAULT DOES NOT MOVE. `null` means "never dragged", and null renders the
 * original `@[50rem]/split:w-[30rem]` class untouched. Only a width the user
 * chose and we persisted is ever applied as an inline override — which also
 * keeps 30rem honest if the root font size is not 16px, where a hardcoded 480
 * would not be.
 */
/* The FLOOR, not a new default. SAME NUMBER, TRUE REASON — this comment used
 * to derive 400 from the 5rem label column of the panel's `LEDGER` grid, and
 * `LEDGER` no longer exists: the panel is one spine of steps on one row recipe.
 *
 * The arithmetic that holds now: the spine's 20px marker column, its 10px
 * gutter and the scroller's 12px inset on both sides leave the label column
 * roughly 350px at the floor. Below that a reasoning paragraph — still the
 * largest surface in the dock, and the reason the number is 400 rather than
 * 320 — drops under ~45 characters, which is the point at which continuous
 * reading costs more in return sweeps than the narrow dock saves in chat
 * width. A ledger was legible at 320; a reading column is not. */
export const THOUGHT_MIN_WIDTH = 400;
/* 30rem at the default 16px root — the width the dock already has. Used ONLY as
 * the starting point for a keyboard nudge (which needs a number to add to) and
 * for the handle's aria-valuenow. It is never applied as a width: an undragged
 * dock keeps rendering the `@[50rem]/split:w-[30rem]` class itself. */
export const THOUGHT_DEFAULT_WIDTH = 480;

/*
 * Where the split engages: the narrowest mount in which an undragged dock and a
 * transcript at its floor both fit. 800px, and the class strings say the same
 * thing as `@[50rem]/split:`. Not CANVAS_MIN_WIDTH + CHAT_MIN_WIDTH (740): the
 * dock's default is the wider of the two panes, and one switch point for both
 * columns is what lets the thought panel and the canvas panel — which are
 * portalled into either surface — carry one set of classes.
 */
export const SPLIT_MIN_WIDTH = CHAT_MIN_WIDTH + THOUGHT_DEFAULT_WIDTH;

/**
 * Whether the docked columns are currently beside the chat rather than covering
 * it — the same question `@[50rem]/split:` answers, asked of the same box.
 *
 * Below the split BOTH docked columns are full-bleed `w-full` — no
 * `w-[var(--juno-thought-width)]`, no `w-[var(--juno-canvas-width)]` — so there
 * is no width to constrain, and clamping there would destroy a width chosen on
 * a wide monitor to satisfy a constraint that does not exist. The dock has
 * always said so; the canvas did not, and clamped at every breakpoint. That was
 * not harmless: `resize` fires continuously on a phone (the URL bar sliding
 * away is enough), so one scroll rewrote a canvas width chosen on a monitor
 * down to the phone bounds and persisted it — for a column that was rendering
 * `w-full` and never read the number. One gate, used by both panes, by every
 * "close the dock before scrolling the chat" path, and by the thought panel's
 * own Back-vs-Close decision.
 *
 * `null` (the mount not committed yet) reads as not split: the pane hook
 * re-measures the moment the mount exists, and a false "split" would clamp a
 * stored width against a box that is not there.
 */
export function splitEngaged(mount: Pick<HTMLElement, "getBoundingClientRect"> | null | undefined): boolean {
  if (!mount) return false;
  return mount.getBoundingClientRect().width >= SPLIT_MIN_WIDTH;
}

export function thoughtWidthBounds(containerWidth: number) {
  return splitBounds({
    containerWidth,
    paneMin: THOUGHT_MIN_WIDTH,
    paneFloor: 280,
    // Reserves CHAT_MIN_WIDTH exactly as canvasWidthBounds does, so dragging the
    // dock can never squeeze the chat below phone width. The 0.6 cap (vs the
    // canvas's 0.82) is the one honest difference: the canvas holds documents the
    // user edits, this holds receipts read beside the chat.
    primaryMin: CHAT_MIN_WIDTH,
    fraction: 0.6,
    // THE DEFAULT MUST ALWAYS BE REACHABLE. `@[50rem]/split:w-[30rem]` is
    // rendered by CSS for an undragged dock no matter what these bounds say, so
    // a max below 480 does not make the panel narrower — it only makes the
    // HANDLE lie: pointer-down (which reads the live edge, i.e. 480) would clamp
    // and snap the dock ~56px narrower before the user moved, and the "grow"
    // arrow would shrink it. The split now engages at exactly 800, so the
    // container can no longer be split AND under 800 — but the cap stays, so
    // the dock can never exceed the layout it lives in.
    cssWidth: THOUGHT_DEFAULT_WIDTH,
  });
}

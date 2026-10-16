/**
 * Behaviour timers: how long the interface WAITS, never how it moves
 * (docs/rework/INTERACTION_SPEC.md §1.2, §1.10; wave 2 spec §4.2). Motion
 * durations live in `@/lib/motion` and the --dur-* tokens; these are the
 * pauses around them, so no component hand-types a delay.
 *
 * The first block mirrors the named timing families of spec §4.2 exactly
 * (`--delay-*`, `--hold-*`), read from the generated tokens, so the lint that
 * accepts `TIMING.<name>` in a framer `delay` accepts the same numbers the CSS
 * carries. The second block is older behaviour timing that has no CSS twin.
 */

import { TIMING_TOKENS } from "@/lib/design/tokens.generated";

const { delay, hold } = TIMING_TOKENS;

export const TIMING = {
  // ── Spec §4.2, generated ───────────────────────────────────────────────────
  /** `--delay-show`: TurnStatus and skeletons wait this long, so fast work never flashes one. */
  show: delay.show,
  /** `--delay-tooltip`: hover intent before the first tooltip. */
  tooltip: delay.tooltip,
  /** `--delay-tooltip-skip`: a peer tooltip within this window opens at once. */
  tooltipSkip: delay.tooltipSkip,
  /** `--delay-hairline`: the palette's in-flight hairline. */
  hairline: delay.hairline,
  /** `--delay-action-row`: the turn's action row after the answer settles. */
  actionRow: delay.actionRow,
  /** `--delay-greeting`: the first-visit greeting's clip-wipe. */
  greeting: delay.greeting,
  /** `--delay-insert-flush`: held row inserts flush this long after the pointer leaves. */
  insertFlush: delay.insertFlush,
  /** `--hold-phase`: a TurnStatus phase word is held at least this long. */
  phase: hold.phase,
  /** `--hold-skeleton`: a shown skeleton stays at least this long. */
  skeleton: hold.skeleton,
  /** `--hold-check`: the ready check waits this long before drawing. */
  check: hold.check,
  /** `--hold-reasoning`: inline reasoning closes this long after it ends. */
  reasoning: hold.reasoning,
  /** `--hold-arm`: an approval's primary verb is disarmed this long after each request or focus entry. */
  arm: hold.arm,
  /** `--hold-needs-you-max`: a needs-you row waits at most this long behind a hovered list. */
  needsYouMax: hold.needsYouMax,
  /** `--hold-insert-max`: any other held insert flushes after this long regardless. */
  insertMax: hold.insertMax,
  /** `--hold-composer-idle`: a composer untouched this long counts as idle (approval focus policy, D20). */
  composerIdle: hold.composerIdle,
  /** The ready check draws only when the reader watched a run longer than this. */
  finishCheckMinWatched: 10_000,
  /** iOS fires the settled haptic only for answers longer than this (kept here for parity). */
  settledHapticMin: 3000,

  // ── Behaviour timing without a CSS twin ───────────────────────────────────
  /** @deprecated Use `show`. */
  showDelay: delay.show,
  /** Once shown, a pending status stays at least this long before another status replaces it. Content replaces it at once. */
  minVisible: 400,
  /** @deprecated Use `tooltip`. */
  tooltipDelay: delay.tooltip,
  hoverCardOpen: 300,
  hoverCardClose: 150,
  copiedHold: 1500,
  /** @deprecated Use `arm`. */
  approvalArm: hold.arm,
  /** Wave 1 phase hold, still read by the run line until P5 moves it to `phase`. */
  phaseMinHold: 1000,
  elapsedAfter: 3000,
  reconnectQuiet: 1000,
  reconnectGiveUp: 10_000,
  slowFirstToken: 10_000,
  toastLife: 4000,
  undoWindow: 10_000,
  draftSave: 300,
  longPress: 450,
} as const;

export type TimingKey = keyof typeof TIMING;

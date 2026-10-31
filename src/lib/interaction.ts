import { TIMING_TOKENS } from "@/lib/design/tokens.generated";

/**
 * Behaviour timers: how long the interface WAITS, never how it moves
 * (docs/rework/INTERACTION_SPEC.md §1.2, §1.10). Motion durations live in
 * `@/lib/motion` and the --dur-* tokens; these are the pauses around them, so
 * no component hand-types a delay.
 *
 * ONE SOURCE. Every wait that has a named timing token (globals.css §4.2:
 * `--delay-*`, `--hold-*`) is READ from the generated table here rather than
 * typed a second time. The two tables used to disagree: this file held the
 * tooltip at 300ms while the CSS held it at 200, a phase word at 1000ms while
 * `--hold-phase` and spec C1 said 600, and the globals comment claimed this
 * file mirrored the tokens when it did not. The rest are behaviour with no
 * motion token (a copy confirmation's hold, a reconnect's patience), still
 * named once, here.
 */
export const TIMING = {
  /** Wait before showing any pending indicator, so fast work never flashes one (`--delay-show`). */
  showDelay: TIMING_TOKENS.delay.show,
  /** Once shown, a pending status stays at least this long before another status replaces it. Content replaces it at once (`--hold-skeleton`). */
  minVisible: TIMING_TOKENS.hold.skeleton,
  /** Hover intent before the first tooltip (`--delay-tooltip`). */
  tooltipDelay: TIMING_TOKENS.delay.tooltip,
  /** A peer's tooltip within this window opens at once (`--delay-tooltip-skip`). */
  tooltipSkip: TIMING_TOKENS.delay.tooltipSkip,
  hoverCardOpen: 300,
  hoverCardClose: 150,
  copiedHold: 1500,
  /** An approval's primary verb stays disarmed this long after it appears (`--hold-arm`, spec C16). */
  approvalArm: TIMING_TOKENS.hold.arm,
  /** The shortest life of a phase word before the next replaces it (`--hold-phase`, spec C1). */
  phaseMinHold: TIMING_TOKENS.hold.phase,
  elapsedAfter: 3000,
  reconnectQuiet: 1000,
  reconnectGiveUp: 10_000,
  slowFirstToken: 10_000,
  toastLife: 4000,
  undoWindow: 10_000,
  draftSave: 300,
  longPress: 450,
} as const;

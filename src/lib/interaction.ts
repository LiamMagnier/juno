/**
 * Behaviour timers and distances, never motion (INTERACTION_SPEC §1.2, §1.10).
 *
 * Durations and curves live in `@/lib/motion` and the CSS tokens; these are
 * the waits and holds that decide WHEN something is shown, how long a state
 * is held, and how far counts as "at the bottom". No component hand-types
 * them. The Swift mirror is `JunoTiming`.
 */
export const TIMING = {
  /** Wait before showing any pending indicator. */
  showDelay: 200,
  /** Once shown, a pending indicator stays at least this long before another status replaces it. */
  minVisible: 400,
  tooltipDelay: 300,
  tooltipSkip: 400,
  hoverCardOpen: 300,
  hoverCardClose: 150,
  /** Copy becomes a check for this long, then copy again. */
  copiedHold: 1500,
  /** An approval's verb ignores activation for this long after it appears or its payload changes. */
  approvalArm: 500,
  /** A live line holds each phase at least this long. */
  phaseMinHold: 1000,
  /** Elapsed seconds join a live line after this. */
  elapsedAfter: 3000,
  reconnectQuiet: 1000,
  reconnectGiveUp: 10_000,
  slowFirstToken: 10_000,
  toastLife: 4000,
  undoWindow: 10_000,
  draftSave: 300,
  longPress: 450,
} as const;

export const DISTANCE = {
  followThreshold: 48,
  anchorPeek: 64,
  jumpShowDistance: 120,
  dragThreshold: 4,
  pasteChipLines: 120,
  pasteChipChars: 8000,
} as const;

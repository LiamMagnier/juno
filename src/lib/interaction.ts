/**
 * Behaviour timers: how long the interface WAITS, never how it moves
 * (docs/rework/INTERACTION_SPEC.md §1.2, §1.10). Motion durations live in
 * `@/lib/motion` and the --dur-* tokens; these are the pauses around them, so
 * no component hand-types a delay.
 */
export const TIMING = {
  /** Wait before showing any pending indicator, so fast work never flashes one. */
  showDelay: 200,
  /** Once shown, a pending status stays at least this long before another status replaces it. Content replaces it at once. */
  minVisible: 400,
  tooltipDelay: 300,
  tooltipSkip: 400,
  hoverCardOpen: 300,
  hoverCardClose: 150,
  copiedHold: 1500,
  approvalArm: 500,
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

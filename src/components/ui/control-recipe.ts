/**
 * A press has one timing across buttons, icon controls and selectable rows.
 * Reduced motion removes only travel; color/opacity still acknowledge the
 * action. Property-specific timing avoids retiming an entrance animation.
 */
export const controlMotionClass =
  "pressable " +
  "motion-reduce:transition-[color,background-color,border-color,opacity,box-shadow,filter] " +
  "motion-reduce:[transition-duration:var(--dur-fast)] " +
  "motion-reduce:[transition-timing-function:var(--ease-out-soft)] " +
  "motion-reduce:active:scale-100";

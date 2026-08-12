/**
 * Window chrome geometry.
 *
 * Shared because it is one of the few numbers that **two processes must agree
 * on exactly**: main positions the native traffic lights, the renderer draws the
 * title bar they sit in, and neither can see the other's result. They did in
 * fact disagree — main was written for a 52px bar and the renderer draws 44px,
 * which put the buttons 4px low. That is precisely the class of defect that no
 * test catches and every user notices.
 *
 * Dependency-free, like `channels.ts`, so the sandboxed preload and the
 * Node-free renderer graph can both import it.
 */

/** The custom title bar's height, in points. */
export const TITLE_BAR_HEIGHT = 44;

/**
 * Left inset the renderer must keep clear for the native traffic lights.
 *
 * The button group is about 52pt wide starting at `TRAFFIC_LIGHT_POSITION.x`;
 * 78 leaves a comfortable gutter before the first control.
 */
export const TRAFFIC_LIGHT_INSET = 78;

/**
 * Top-left corner of the native traffic-light group.
 *
 * `y` is derived, not chosen: the buttons are 12pt tall on Big Sur and later, so
 * centring them in the bar is `(TITLE_BAR_HEIGHT - 12) / 2`. Keep it derived —
 * hardcoding it is how it drifted from the bar height the first time.
 */
export const TRAFFIC_LIGHT_BUTTON_HEIGHT = 12;

export const TRAFFIC_LIGHT_POSITION = {
  x: 19,
  y: (TITLE_BAR_HEIGHT - TRAFFIC_LIGHT_BUTTON_HEIGHT) / 2,
} as const;

/**
 * Inset while full screen.
 *
 * macOS hides the traffic lights in full screen, so the renderer reclaims the
 * space and only keeps a small gutter.
 */
export const FULLSCREEN_INSET = 12;

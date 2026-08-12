/**
 * `-webkit-app-region`, typed.
 *
 * This is the property that decides which pixels of a frameless window drag the
 * window and which ones behave like ordinary controls. csstype does not carry
 * it (it is Electron/Chromium-specific and not in any CSS spec), so without
 * this augmentation every drag region in the title bar would need an
 * `as CSSProperties` cast — and a cast is exactly the thing that stops the
 * compiler from noticing the day someone writes `'no_drag'`.
 *
 * Values are constrained to the two Electron accepts. `no-drag` exists to punch
 * holes in a drag region for interactive controls; a button inside a drag
 * region that omits it is not clickable, it just moves the window.
 */
import type {} from 'react';

declare module 'react' {
  interface CSSProperties {
    WebkitAppRegion?: 'drag' | 'no-drag' | undefined;
  }
}

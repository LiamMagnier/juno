/**
 * The three window operations the renderer is allowed to request.
 *
 * They live in `lib` rather than beside the title bar because the title bar
 * does not use them: macOS already draws minimise, zoom and fullscreen, and
 * drawing a second set inside the window is one of the clearest signs that an
 * app is a web page in a frame. They are reached from the command palette and
 * from the menu bar instead — discoverable, keyboard-first, and not duplicated
 * in the chrome.
 *
 * `tryInvoke` rather than `invoke`: a missing bridge here should be a no-op,
 * not an unhandled promise rejection in a click handler.
 */

import { tryInvoke } from './bridge.js';

export const windowActions = {
  minimize: (): void => void tryInvoke('window:minimize'),
  toggleMaximize: (): void => void tryInvoke('window:toggle-maximize'),
  toggleFullscreen: (): void => void tryInvoke('window:toggle-fullscreen'),
};

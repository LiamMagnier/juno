/**
 * The terminal product's public surface.
 *
 * `TerminalProduct` is the only component the rest of the renderer should
 * mount; everything else is exported for tests and for whoever ends up owning
 * the design-token side of the palette. Importing `TerminalPane` directly
 * outside this directory means owning terminal lifecycle by hand, which is the
 * mistake `TerminalProduct` exists to prevent.
 */

export { TerminalProduct, type TerminalProductProps } from './TerminalProduct.js';
export { TerminalTabs, type TerminalTabsProps } from './TerminalTabs.js';
export { TerminalPane, type TerminalPaneProps } from './TerminalPane.js';

export {
  buildTerminalTheme,
  themeFingerprint,
  MINIMUM_CONTRAST_RATIO,
  TERMINAL_FONT_FALLBACK,
  TERMINAL_TOKENS,
  type TerminalThemeResult,
} from './theme.js';

export { terminalBridge, isChannelMissingError, type TerminalBridge } from './bridge.js';

export type {
  TerminalSummary,
  TerminalStatus,
  TerminalSignal,
  TerminalOutputEvent,
  TerminalExitEvent,
} from './protocol.js';

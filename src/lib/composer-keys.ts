/**
 * What Enter does in a message composer, one rule for every one of them
 * (Chat and Code on the web, and the native apps' `JunoComposerReturn`):
 *
 * - Enter sends.
 * - Shift+Enter and Option/Alt+Enter break the line.
 * - While an input method is composing (Japanese, Chinese, Korean and the
 *   like), Enter belongs to it: it confirms the text and never sends.
 *   Safari reports that confirming keydown after `compositionend`, with
 *   `isComposing` already false and keyCode 229, so both are checked.
 *
 * Pure: the components wire the event to it.
 */

export type EnterIntent = "send" | "newline" | "ime";

export interface EnterKey {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/** Null for any key but Enter. */
export function enterIntent(e: EnterKey): EnterIntent | null {
  if (e.key !== "Enter") return null;
  if (e.isComposing || e.keyCode === 229) return "ime";
  if (e.shiftKey || e.altKey) return "newline";
  return "send";
}

/*
 * ON A TOUCH KEYBOARD, RETURN BREAKS THE LINE (G35).
 *
 * The send disc sits under the thumb; Return on an on-screen keyboard is where
 * a person reaches for a new line, as it is in every messaging app that is not
 * a terminal (ChatGPT's and Claude's mobile web do the same). A tablet with a
 * real keyboard attached keeps Return-to-send: the first key only a physical
 * keyboard sends (Tab, Esc, an arrow, a ⌘/Ctrl chord) proves it is there.
 *
 * Settings › Keyboard keeps both overrides: "Send with ⌘ Enter" everywhere,
 * and on a touch device "Return sends" for people who want the old way.
 */

/** What Return does on an on-screen keyboard (Settings › Keyboard, touch devices). */
export type TouchReturn = "newline" | "send";

export interface ReturnContext {
  /** Settings › Keyboard: "enter" or "mod-enter". */
  sendKey: "enter" | "mod-enter";
  /** Settings › Keyboard on a touch device. */
  touchReturn: TouchReturn;
  /** The primary pointer is a finger and no fine pointer (mouse, trackpad) is attached. */
  touchPrimary: boolean;
  /** A key only a physical keyboard sends has been pressed since the page loaded. */
  hardwareKeyboardSeen: boolean;
  /**
   * The on-screen keyboard is up right now (the visual viewport is measurably
   * shorter than the layout viewport). Null when it cannot be measured.
   */
  softKeyboardOpen: boolean | null;
}

/** True when the Return about to be pressed comes from an on-screen keyboard. */
export function onScreenKeyboard(ctx: Pick<ReturnContext, "touchPrimary" | "hardwareKeyboardSeen" | "softKeyboardOpen">): boolean {
  if (!ctx.touchPrimary) return false;
  // Measured: the keyboard is on screen, whatever was pressed earlier (a
  // detached keyboard folds the on-screen one back up).
  if (ctx.softKeyboardOpen === true) return true;
  return !ctx.hardwareKeyboardSeen;
}

/**
 * Whether a Return that `enterIntent` called "send" really sends. False means
 * the field should break the line instead. ⌘/Ctrl+Return always sends.
 */
export function returnSends(ctx: ReturnContext, modifier: boolean): boolean {
  if (modifier) return true;
  if (ctx.sendKey === "mod-enter") return false;
  if (onScreenKeyboard(ctx)) return ctx.touchReturn === "send";
  return true;
}

/**
 * Keys an on-screen keyboard does not send: evidence a physical keyboard is
 * attached. A ⌘ or Ctrl chord counts too; Shift and letters do not (every
 * on-screen keyboard has them).
 */
export function isHardwareOnlyKey(e: { key: string; metaKey?: boolean; ctrlKey?: boolean }): boolean {
  if (e.metaKey || e.ctrlKey) return true;
  return HARDWARE_ONLY_KEYS.has(e.key) || /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(e.key);
}

const HARDWARE_ONLY_KEYS = new Set([
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Insert",
  "CapsLock",
]);

/** The `enterkeyhint` an on-screen keyboard should draw on its Return key. */
export function enterKeyHintFor(ctx: ReturnContext): "enter" | "send" {
  return returnSends(ctx, false) ? "send" : "enter";
}

/** The fields of a React keyboard event the rule reads. */
export function enterKeyOf(e: { key: string; shiftKey: boolean; altKey: boolean; nativeEvent: { isComposing?: boolean; keyCode?: number } }): EnterKey {
  return { key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing, keyCode: e.nativeEvent.keyCode };
}

/**
 * Inserts a line break at the caret of the focused textarea, replacing the
 * selection, through the browser's own editing (so it stays undoable and
 * React's onChange sees it). A browser does that by itself for Shift+Enter,
 * not reliably for Alt+Enter. Returns false when it could not.
 */
export function insertLineBreak(doc: Document = document): boolean {
  try {
    return doc.execCommand("insertText", false, "\n");
  } catch {
    return false;
  }
}

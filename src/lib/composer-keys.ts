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

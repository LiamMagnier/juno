/**
 * WHERE FOCUS GOES WHEN AN APPROVAL ARRIVES (spec D20, §10).
 *
 *   take      focus moves to the approval container (role=group, tabIndex −1)
 *   announce  focus stays put; the announcer speaks, and a "Review approval"
 *             button is inserted right after the active input in tab order
 *
 * Take applies only when focus is in the thread (or nowhere), or in a
 * composer that is empty, or that has had no keystroke and no selection for
 * `--hold-composer-idle` (2s). Anywhere else — xterm, a dock input, a
 * composer the reader is typing in or has a selection in, any other field —
 * the approval announces instead of stealing focus. An approval never replaces
 * a draft.
 *
 * Surfaces mark their regions with these selectors (P5 composer and thread,
 * P6 dock and xterm); the composer reports its own state.
 */

import { TIMING } from "@/lib/interaction";

export type FocusPolicy = "take" | "announce";

export interface ComposerState {
  /** The draft is empty (no text, no attachments). */
  empty: boolean;
  /** When the reader last typed in it (ms, same clock as `now`), or null for never. */
  lastInputAt: number | null;
  /** Text is selected in it. */
  hasSelection?: boolean;
}

export const COMPOSER_SELECTOR = "[data-composer], [data-composer-draft], .composer-surface";
export const THREAD_SELECTOR = "[data-thread], [role='log'], [data-transcript], .turn-body";
export const XTERM_SELECTOR = ".xterm, [data-xterm]";

/** A composer counts as idle after this long without a keystroke or a selection. */
export const COMPOSER_IDLE_MS = TIMING.composerIdle;

/** Whether the composer is empty, or idle for 2s with nothing selected. */
export function composerYields(state: ComposerState, now: number): boolean {
  if (state.empty) return true;
  if (state.hasSelection) return false;
  return state.lastInputAt === null || now - state.lastInputAt >= COMPOSER_IDLE_MS;
}

type FocusTarget = Pick<Element, "closest"> | null | undefined;

/**
 * The policy for an approval arriving while `activeElement` has focus.
 * `composer` is the composer's state when focus is inside it.
 */
export function resolveFocusPolicy(activeElement: FocusTarget, composer: ComposerState | null, now: number = Date.now()): FocusPolicy {
  if (!activeElement) return "take";
  const tag = (activeElement as Element).tagName;
  if (tag === "BODY" || tag === "HTML") return "take";
  if (activeElement.closest(XTERM_SELECTOR)) return "announce";
  if (activeElement.closest(COMPOSER_SELECTOR)) return composer && composerYields(composer, now) ? "take" : "announce";
  if (activeElement.closest(THREAD_SELECTOR)) return "take";
  return "announce";
}

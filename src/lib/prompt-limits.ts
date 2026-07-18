/**
 * Prompt / input size policy.
 *
 * There is intentionally **no application character cap** on:
 * - chat user messages (composer → /api/chat)
 * - private-history turns
 * - clarification originals
 * - custom instructions
 * - saved prompt library bodies
 * - project instructions
 *
 * The only real limit is the selected model's context window (enforced by the
 * provider). Soft helpers below only affect UI so multi-MB pastes don't freeze
 * or blank the page; the full text is still sent / stored.
 */

/** Soft UI collapse for very long bubbles (full text still in state / API). */
export const MESSAGE_DISPLAY_COLLAPSE_CHARS = 12_000;

/**
 * Above this, the composer shows a compact "large paste" card instead of
 * keeping tens of thousands of characters live in the textarea DOM. Full text
 * remains in React state and is sent on Submit.
 */
export const COMPOSER_INLINE_SOFT_CHARS = 8_000;

/** Soft banner: offer "Attach as file" once the draft is long. */
export const COMPOSER_LONG_TEXT_CHARS = 1_500;

/** @deprecated No longer enforced — kept so native clients compiling against the old export don't break. */
export const MAX_USER_MESSAGE_CHARS = Number.MAX_SAFE_INTEGER;

/** @deprecated No longer enforced. */
export const MAX_CLARIFY_MESSAGE_CHARS = Number.MAX_SAFE_INTEGER;

/** @deprecated No longer enforced. */
export const MAX_EDIT_MESSAGE_CHARS = Number.MAX_SAFE_INTEGER;

/** @deprecated No longer enforced. */
export const MAX_CUSTOM_INSTRUCTIONS_CHARS = Number.MAX_SAFE_INTEGER;

/** @deprecated No longer enforced. */
export const MAX_PROMPT_BODY_CHARS = Number.MAX_SAFE_INTEGER;

/** @deprecated No longer enforced. */
export const MAX_PROJECT_INSTRUCTIONS_CHARS = Number.MAX_SAFE_INTEGER;

/** Sample-based newline count — never split multi-MB strings. */
export function sampleLineCount(text: string, sampleChars = 4_000): number {
  if (!text) return 0;
  const sample = text.length > sampleChars ? text.slice(0, sampleChars) : text;
  let n = 1;
  for (let i = 0; i < sample.length; i++) {
    if (sample.charCodeAt(i) === 10) n++;
  }
  return n;
}

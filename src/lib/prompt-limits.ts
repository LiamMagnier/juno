/**
 * Prompt / input size policy.
 *
 * There is intentionally **no application character cap** on user messages,
 * private-history turns, or clarification originals. The only real limit is
 * the selected model's context window (enforced by the provider).
 *
 * Display helpers below only affect the UI so multi-MB pastes don't freeze or
 * blank the page; the full text is still sent to the API and stored.
 */

/** Soft UI collapse for very long bubbles (full text still in state / API). */
export const MESSAGE_DISPLAY_COLLAPSE_CHARS = 12_000;

/** @deprecated No longer enforced — kept so native clients compiling against the old export don't break. */
export const MAX_USER_MESSAGE_CHARS = Number.MAX_SAFE_INTEGER;

/** @deprecated No longer enforced. */
export const MAX_CLARIFY_MESSAGE_CHARS = Number.MAX_SAFE_INTEGER;

/** @deprecated No longer enforced. */
export const MAX_EDIT_MESSAGE_CHARS = Number.MAX_SAFE_INTEGER;

/**
 * Application-level ceilings for user-supplied text.
 *
 * There is intentionally no small "app" cap like 50k — that rejected large
 * pastes long before the model context window did, and large private-history
 * POSTs / long request lines could surface as 414 Request-URI Too Large at
 * the reverse proxy when headers/URI buffers were undersized.
 *
 * Practical limit = the selected model's context window (enforced by the
 * provider). These numbers are only a safety rail against accidental multi-
 * hundred-MB payloads that would OOM the Node process.
 */

/** Single user message / private-history turn (chars). ~1–2M tokens of plain text worst-case. */
export const MAX_USER_MESSAGE_CHARS = 5_000_000;

/** Clarification / preflight originals — same as a user message. */
export const MAX_CLARIFY_MESSAGE_CHARS = MAX_USER_MESSAGE_CHARS;

/** Message edit / native append. */
export const MAX_EDIT_MESSAGE_CHARS = MAX_USER_MESSAGE_CHARS;

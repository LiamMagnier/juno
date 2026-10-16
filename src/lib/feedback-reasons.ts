/**
 * Why an answer was rated down — the reason picker's vocabulary.
 *
 * A thumbs-down used to carry nothing but DOWN, and it played the same swell
 * and particle burst as a thumbs-up: the product thanked the reader for
 * telling it that it had failed. Now the down thumb opens a calm picker
 * (message-feedback.tsx) with these six reasons and an optional note.
 *
 * The ids are the stored values (Message.feedbackReason and, without the note,
 * RoutingOutcome.feedbackReason), so they never change once shipped. The
 * labels are UI copy and may. `FEEDBACK_REASON_LABEL` is named so the i18n
 * extractor (scripts/generate-i18n-catalog.mjs) walks it in full.
 *
 * Shared by the client and the route, so this file imports nothing that only
 * one side can load.
 */

export const FEEDBACK_REASONS = [
  "inaccurate",
  "ignored_instructions",
  "too_long",
  "refused",
  "formatting",
  "other",
] as const;

export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

export const FEEDBACK_REASON_LABEL: Record<FeedbackReason, string> = {
  inaccurate: "Not accurate",
  ignored_instructions: "Didn’t follow instructions",
  too_long: "Too long",
  refused: "Refused or unsafe",
  formatting: "Bad formatting",
  other: "Something else",
};

/** The note is optional and short: a sentence or two, not an essay. */
export const FEEDBACK_NOTE_LIMIT = 1000;

export function isFeedbackReason(value: unknown): value is FeedbackReason {
  return typeof value === "string" && (FEEDBACK_REASONS as readonly string[]).includes(value);
}

/** Trim, collapse runs of blank lines and cap. Empty means "no note". */
export function normalizeFeedbackNote(note: string | null | undefined): string | null {
  if (typeof note !== "string") return null;
  const trimmed = note.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!trimmed) return null;
  return trimmed.length > FEEDBACK_NOTE_LIMIT ? trimmed.slice(0, FEEDBACK_NOTE_LIMIT) : trimmed;
}

export type FeedbackValue = "UP" | "DOWN" | null;

export interface FeedbackDetail {
  reason?: FeedbackReason | null;
  note?: string | null;
}

/**
 * What one feedback request writes to the message row.
 *
 *   - Anything but DOWN clears the reason and the note: a reason for a rating
 *     the reader has taken back would be a claim they no longer make.
 *   - DOWN with neither field leaves both alone. The thumb records DOWN the
 *     moment it is pressed and the picker follows with the reason, so the two
 *     requests can land in either order; and the native apps still send a bare
 *     DOWN. Neither may wipe a reason the reader already gave.
 *   - DOWN with a field sets it (null clears it).
 *
 * `note` is the plain text here; the route seals it before it is stored.
 */
export function feedbackWrite(
  feedback: FeedbackValue,
  detail: FeedbackDetail = {},
): { feedback: FeedbackValue; feedbackReason?: FeedbackReason | null; feedbackNote?: string | null } {
  if (feedback !== "DOWN") return { feedback, feedbackReason: null, feedbackNote: null };
  return {
    feedback,
    ...(detail.reason !== undefined ? { feedbackReason: detail.reason } : {}),
    ...(detail.note !== undefined ? { feedbackNote: normalizeFeedbackNote(detail.note) } : {}),
  };
}

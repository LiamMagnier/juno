/**
 * The user turn's bubble, in one string.
 *
 * FLAT_UI.md: the transcript stays flat, and the user bubble is the ONE tonal
 * fill in it, with the bottom-right corner tucked toward the margin the
 * message hangs from. This is the Claude / ChatGPT bubble: a shade of the
 * page, never a box with an edge.
 *
 * Shared by the live transcript (message-item.tsx) and the public share page
 * (share/shared-chat-transcript.tsx), which were carrying two hand-copied
 * versions of it. A shared message must look like the message it was.
 *
 * `text-reading`, the rung `.prose-juno` sets the reply in (globals.css), so
 * a question and its answer are one size. The bubble was `text-body` (15px)
 * with a `leading-relaxed` of its own; the rung now carries both numbers.
 *
 * `rounded-panel` (16), not the composer's 28: on a two-line question the
 * composer radius exceeded half the bubble's height and read as a pill.
 */
export const USER_BUBBLE_CLASS =
  "whitespace-pre-wrap rounded-panel bg-[hsl(var(--user-bubble))] px-4 py-2.5 text-reading";

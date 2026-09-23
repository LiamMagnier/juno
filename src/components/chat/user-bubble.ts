/**
 * The user turn's bubble, in one string.
 *
 * FLAT_UI.md: the transcript stays flat, and the user bubble is the ONE tonal
 * fill in it — `bg-secondary` at `rounded-card`, no border, no shadow, with
 * the bottom-right corner tucked (`rounded-br-md`) toward the margin the
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
 */
export const USER_BUBBLE_CLASS =
  "whitespace-pre-wrap rounded-card rounded-br-md bg-secondary px-4 py-2.5 text-reading";

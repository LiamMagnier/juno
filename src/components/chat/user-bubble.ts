/**
 * The user turn's bubble, in one string.
 *
 * The user message has a tonal surface and a tighter corner at the inline
 * end. Shared transcripts use the same spacing, colour and radius.
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
  "conversation-user-bubble whitespace-pre-wrap px-4 py-2.5 text-reading";

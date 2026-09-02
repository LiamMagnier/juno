/**
 * The user turn's bubble, in one string.
 *
 * SOFT_UI.md §1.4: the transcript stays flat, and the user bubble is the ONE
 * gently inset well in it — `.surface-inset` at `rounded-card` with the
 * bottom-right corner tucked (`rounded-br-md`) toward the margin the message
 * hangs from. No raised shadow, no glass: depth is for chrome and controls,
 * and a reading surface that casts a shadow is a card, not a message.
 *
 * Shared by the live transcript (message-item.tsx) and the public share page
 * (share/shared-chat-transcript.tsx), which were carrying two hand-copied
 * versions of it. A shared message must look like the message it was.
 */
export const USER_BUBBLE_CLASS =
  "surface-inset whitespace-pre-wrap rounded-card rounded-br-md border-border/50 px-4 py-2.5 text-body leading-relaxed";

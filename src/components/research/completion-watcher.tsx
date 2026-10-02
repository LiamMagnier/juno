"use client";

/*
 * Notices when a run finishes while the reader is elsewhere (SPEC §9.8,
 * DECISIONS R7): the tab title through the title override, a toast, and an
 * opt-in browser notification. Mounted once in the app shell.
 *
 * WS0 STUB: final props, renders nothing. WS8 builds it; WS9c mounts it.
 */

export interface ResearchCompletionWatcherProps {
  /** The conversation on screen, or null; no toast for a run the reader is already looking at. */
  activeConversationId: string | null;
}

export function ResearchCompletionWatcher(_props: ResearchCompletionWatcherProps) {
  return null;
}

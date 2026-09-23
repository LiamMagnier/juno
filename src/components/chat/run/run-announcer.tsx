"use client";

import * as React from "react";

/*
 * The chat's one polite live region (SPEC §7.12, DECISIONS U6): phase
 * boundaries of the streaming message, and Research phases published through
 * `publishResearchPhase`, spaced at least 3 s apart; waiting jumps the queue.
 *
 * WS0 STUB: final props, placeholder body. WS5 builds it; WS9b mounts it in
 * the message list.
 */

export interface RunAnnouncerProps {
  /** renderKey of the message that is streaming, or null. */
  streamingRenderKey: string | null;
  /** The Activity panel covers the transcript (sheet mode): approvals are announced as in the panel. */
  panelCoversChat: boolean;
}

export function RunAnnouncer(_props: RunAnnouncerProps) {
  return <span data-stub="run-announcer" role="status" aria-live="polite" className="sr-only" data-no-auto-translate />;
}

"use client";

import * as React from "react";

/*
 * The Activity panel (SPEC §8.3, DECISIONS U3): the detail surface for one
 * message's run — Timeline, Sources (Cited / Also read) and Details — keyed by
 * the message's stable `renderKey`, so it stays open across completion.
 *
 * WS0 STUB: final props, placeholder body. WS6 builds it.
 */

export interface ActivityPanelProps {
  /** Identity; never the message id (B1). */
  renderKey: string;
  /** Scroll to and expand this call. */
  focusCallId?: string;
  onClose(): void;
  /** "Ask to run again" on a failed third-party call. */
  seedDraft?(text: string): void;
  coversChat(): boolean;
}

export function ActivityPanel({ renderKey }: ActivityPanelProps) {
  return <div data-stub="activity-panel" data-render-key={renderKey} />;
}

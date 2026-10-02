"use client";

import * as React from "react";
import type { ChatMessage } from "@/hooks/use-chat";
import type { GenerationStatus } from "@/types/chat";

/*
 * The inline run block above each chat answer, from send to done (SPEC §7.1,
 * DECISIONS U1): the status line, the two-slot peek while live, approval
 * slots, the inline timeline on click, and the commentary region.
 *
 * WS0 STUB: final props, placeholder body. WS5 builds it; WS9b mounts it.
 */

/** Where the Activity panel should open: a call to scroll to and expand, or the top. */
export interface PanelFocus {
  callId?: string;
}

export interface RunBlockProps {
  message: ChatMessage;
  /** Identity across the temp → server id swap; keys the phase store. */
  renderKey: string;
  streaming: boolean;
  status: GenerationStatus;
  onOpenPanel(focus?: PanelFocus): void;
}

export function RunBlock({ renderKey }: RunBlockProps) {
  return <div data-stub="run-block" data-render-key={renderKey} />;
}

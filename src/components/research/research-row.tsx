"use client";

import * as React from "react";
import type { RightPanelState } from "@/components/chat/panel/panel-state";

/*
 * A live run's one line in the transcript (SPEC §9.11.3, DECISIONS R4): the
 * phase sentence, a favicon stack, "N sources", the working clock and "Open".
 * It swaps in place to "Report ready" when the run completes.
 *
 * WS0 STUB: final props, placeholder body. WS8 builds it; WS9c places it.
 */

type ResearchView = Extract<RightPanelState, { kind: "research" }>["view"];

export interface ResearchRowProps {
  runId: string;
  /** Opens the Research panel on this run ("progress" while live, "report" once done). */
  onOpen(runId: string, view: ResearchView): void;
}

export function ResearchRow({ runId }: ResearchRowProps) {
  return <div data-stub="research-row" data-run-id={runId} />;
}

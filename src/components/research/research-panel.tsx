"use client";

import * as React from "react";
import type { RightPanelState } from "@/components/chat/panel/panel-state";

/*
 * The Research panel inside the right-column shell (SPEC §9.11.4):
 * Progress · Sources · Plan while live, Report · Sources · Plan · Details when
 * done, with Pause/Resume, Finish now and Cancel in the header.
 *
 * WS0 STUB: final props, placeholder body. WS8 builds it; WS9c mounts it.
 */

type ResearchView = Extract<RightPanelState, { kind: "research" }>["view"];

export interface ResearchPanelProps {
  runId: string;
  view: ResearchView;
  onViewChange(view: ResearchView): void;
  onClose(): void;
  coversChat(): boolean;
}

export function ResearchPanel({ runId }: ResearchPanelProps) {
  return <div data-stub="research-panel" data-run-id={runId} />;
}

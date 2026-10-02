"use client";

import * as React from "react";

/*
 * Research's one gate (SPEC §9.11.2, DECISIONS R2): the approach, 3–6 editable
 * questions, optional clarifications, the favoured sources and the estimate
 * line, with Start as the primary action. It reads its run through the
 * research hooks by id.
 *
 * WS0 STUB: final props, placeholder body. WS8 builds it; WS9c places it.
 */

export interface ScopeCardProps {
  runId: string;
  /** Full size only at the transcript tail; elsewhere a one-line "Plan ready · Review" row. */
  atTail: boolean;
  /** After Start: focus moves to the run's Research row. */
  onStarted?(runId: string): void;
}

export function ScopeCard({ runId }: ScopeCardProps) {
  return <div data-stub="scope-card" data-run-id={runId} />;
}

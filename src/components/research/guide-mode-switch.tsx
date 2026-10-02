"use client";

import * as React from "react";

/*
 * The composer's explicit steering mode while a run works (SPEC §9.7,
 * DECISIONS R6): a two-segment "Ask Juno | Guide the research" switch, Ask by
 * default, so a follow-up question never silently becomes guidance.
 *
 * WS0 STUB: final props, placeholder body. WS8 builds it; WS9c places it.
 */

export type GuideMode = "ask" | "guide";

export interface GuideModeSwitchProps {
  mode: GuideMode;
  onModeChange(mode: GuideMode): void;
  disabled?: boolean;
}

export function GuideModeSwitch({ mode }: GuideModeSwitchProps) {
  return <div data-stub="guide-mode-switch" data-mode={mode} />;
}

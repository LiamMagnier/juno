"use client";

import * as React from "react";
import { RESEARCH_COPY } from "@/components/research/copy";
import type { GuideMode } from "@/components/research/steer";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { usePhrase } from "@/lib/i18n-phrase";
import { cn } from "@/lib/utils";

/*
 * The composer's explicit steering mode while a run works (SPEC §9.7,
 * DECISIONS R6): a two-segment "Ask Juno | Guide the research" switch, Ask by
 * default, so a follow-up question never silently becomes guidance.
 *
 * The house segmented control (a radiogroup: one tab stop, arrows move the
 * selection). It stays mounted while a chat stream runs rather than hiding and
 * reappearing, so the composer never shifts under the reader. Which mode a send
 * obeys is `steerTarget` (steer.ts); integration places the switch above the
 * composer input and swaps its placeholder and Send name in Guide mode.
 */

export type { GuideMode } from "@/components/research/steer";

export interface GuideModeSwitchProps {
  mode: GuideMode;
  onModeChange(mode: GuideMode): void;
  disabled?: boolean;
  className?: string;
}

export function GuideModeSwitch({ mode, onModeChange, disabled, className }: GuideModeSwitchProps) {
  const ask = usePhrase(RESEARCH_COPY.steer.ask);
  const guide = usePhrase(RESEARCH_COPY.steer.guide);
  const name = usePhrase(RESEARCH_COPY.steer.switchName);
  const options = React.useMemo<SegmentedOption<GuideMode>[]>(
    () => [
      { value: "ask", label: ask, disabled },
      { value: "guide", label: guide, disabled },
    ],
    [ask, guide, disabled],
  );
  return (
    <SegmentedControl
      value={mode}
      onChange={onModeChange}
      options={options}
      ariaLabel={name}
      className={cn("w-fit", className)}
      optionClassName="whitespace-nowrap"
    />
  );
}

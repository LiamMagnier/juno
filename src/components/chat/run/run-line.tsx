"use client";

import * as React from "react";

import { FaviconStack } from "@/components/chat/run/favicon-stack";
import { RunClock } from "@/components/chat/run/run-clock";
import { RunFacts } from "@/components/chat/run/run-facts";
import { RunGlyph } from "@/components/chat/run/run-glyph";
import { RunLabel } from "@/components/chat/run/run-label";
import { ChevronRight } from "@/components/ui/icons";
import { Pressable } from "@/components/ui/pressable";
import { StatusIcons } from "@/lib/app-icons";
import { useUiLocale } from "@/lib/i18n-format";
import { Phrase } from "@/lib/i18n-phrase";
import { RUN_PACING } from "@/lib/motion";
import { RUN_COPY } from "@/lib/run/presentation";
import { useLoopClaim, useRunPhase } from "@/lib/run/store";
import {
  captionKey,
  hasWarnings,
  isSettledPhase,
  isWorkingPhase,
  lineAccessibleName,
  liveFacts,
  phaseLine,
  type RunOutcome,
} from "@/lib/run/summary";
import type { PacedPhase, RunPhase, RunView } from "@/lib/run/types";
import { cn } from "@/lib/utils";

/*
 * The run's one status line (SPEC §7.1, §7.5): glyph, label, facts, favicon
 * stack and clock while working; the summary and a chevron at rest. A press
 * toggles the inline timeline. It reads its paced phase from the phase store
 * under `renderKey`, so only the line re-renders when the phase changes.
 *
 * Geometry is in rem so the reader's text size scales it (36 px at the 16 px
 * default, 44 px on coarse pointers), with `leading-6` pinned in both states
 * so the live → settled swap never changes the row's height. Below a 28rem
 * container the facts and the favicons drop out; the accessible name still
 * carries them.
 */

export interface RunLineProps {
  /** The message's stable client key; the phase store is keyed by it. */
  renderKey: string;
  view: RunView;
  /** The turn is still streaming. */
  streaming: boolean;
  /** The inline timeline is open (aria-expanded). */
  expanded: boolean;
  onToggle(): void;
  /** id of the inline timeline; `aria-controls` is set only while it is mounted. */
  controlsId?: string;
  /** Loop-arbiter id for the glyph and the shimmer. */
  loopId: string;
  /**
   * How a finished run ended, for the first paint before its phase is
   * published (a reload, or server rendering). Default "done".
   */
  restPhase?: RunOutcome;
}

const QUIET: Omit<PacedPhase, "phase" | "reveal"> = { stalled: false, calm: false, escalation: 0 };

/**
 * The worked time the summary shows: the live clock's last value when this
 * tab watched the run (so the settled line never re-rounds what it showed),
 * else the server's timing. Whole seconds, as the clock showed them.
 */
export function summaryWorkedMs(phase: Pick<PacedPhase, "clock">, view: RunView): number | null {
  const ms = phase.clock ? phase.clock.elapsedMs : view.timing.workedMs;
  return ms === null ? null : Math.floor(Math.max(0, ms) / 1000) * 1000;
}

function outcomeOf(phase: RunPhase): RunOutcome {
  return phase === "stopped" ? "stopped" : phase === "failed" ? "failed" : "done";
}

export function RunLine({ renderKey, view, streaming, expanded, onToggle, controlsId, loopId, restPhase = "done" }: RunLineProps) {
  const locale = useUiLocale();
  const published = useRunPhase(renderKey);
  const paced: PacedPhase =
    published ?? (streaming ? { phase: "queued", reveal: "none", ...QUIET } : { phase: restPhase, reveal: "label", ...QUIET });
  const { phase, reveal } = paced;
  const settled = isSettledPhase(phase);
  const working = isWorkingPhase(phase);
  const live = streaming && !settled;

  useLoopClaim(loopId, 2, streaming && working && reveal !== "none");

  const workedMs = summaryWorkedMs(paced, view);
  const line = phaseLine(paced, view, { locale, workedMs, outcome: outcomeOf(phase) });
  // The summary keeps one identity from the first answer text to done, so
  // `done` does not replay the swap; a stop or a failure is a new line.
  const motionKey = settled ? `summary:${outcomeOf(phase)}` : `${phase}|${paced.subjectKey ?? ""}`;
  const caption = live ? captionKey(paced) : null;
  const warned = settled && hasWarnings(view);
  const failed = phase === "failed";

  const name = lineAccessibleName(view, { phase, workedMs, locale });

  return (
    <Pressable
      kind="row"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-controls={expanded ? controlsId : undefined}
      aria-label={name}
      data-no-auto-translate
      data-run-line=""
      className={cn(
        "-mx-2 w-[calc(100%+1rem)] min-h-9 gap-2.5 px-2 py-1.5 leading-6 coarse:min-h-11",
        // Warning is the one failure ink in the run UI (design system §2.2).
        failed && "text-warning-foreground",
      )}
    >
      <RunGlyph
        phase={phase}
        calm={paced.calm}
        loopId={loopId}
        className={cn("transition-opacity duration-base ease-out-soft", reveal === "none" && "opacity-0")}
      />
      <span className={cn("flex min-w-0 flex-1 items-baseline gap-2", reveal !== "label" && "invisible")}>
        <RunLabel line={line} motionKey={motionKey} live={live} calm={paced.calm} loopId={loopId} className={cn(failed && "text-warning-foreground")} />
        {caption ? (
          <span
            className={cn(
              "hidden min-w-0 shrink truncate text-caption @[28rem]/run:inline",
              caption === "stalledFor" ? "text-warning-foreground" : "text-muted-foreground",
            )}
          >
            <Phrase text={RUN_COPY[caption]} />
            {caption === "stalledFor" && paced.stalledSince !== undefined ? (
              <>
                {" "}
                <RunClock elapsedMs={0} since={paced.stalledSince} className="text-inherit" />
              </>
            ) : null}
          </span>
        ) : null}
        {live ? <RunFacts facts={liveFacts(view)} className="hidden @[28rem]/run:inline" /> : null}
      </span>
      {view.sourceUrls?.length ? (
        <FaviconStack
          sources={view.sourceUrls.map((url) => ({ url }))}
          className={cn("hidden @[28rem]/run:inline-flex", reveal !== "label" && "invisible")}
        />
      ) : null}
      {live ? (
        <RunClock
          elapsedMs={paced.clock?.elapsedMs ?? 0}
          since={paced.clock?.since ?? null}
          showAfterMs={RUN_PACING.timerAfterMs}
        />
      ) : (
        <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
          {warned ? <StatusIcons.warning aria-hidden="true" className="size-3 text-warning-foreground" /> : null}
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3.5 transition-transform duration-base ease-in-out rtl:-scale-x-100 motion-reduce:transition-none",
              expanded && "rotate-90 rtl:-rotate-90",
            )}
          />
        </span>
      )}
    </Pressable>
  );
}

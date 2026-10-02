"use client";

import * as React from "react";
import type { RightPanelState } from "@/components/chat/panel/panel-state";
import { FaviconStack } from "@/components/chat/run/favicon-stack";
import { RunClock } from "@/components/chat/run/run-clock";
import { RunGlyph } from "@/components/chat/run/run-glyph";
import { RunLabel } from "@/components/chat/run/run-label";
import { RESEARCH_COPY, sourcesCount } from "@/components/research/copy";
import {
  researchClock,
  rowFavicons,
  rowLine,
  rowNameLine,
  rowOpensView,
  rowSourceCount,
} from "@/components/research/research-view";
import { useResearchRun } from "@/components/research/use-research-run";
import { ChevronRight } from "@/components/ui/icons";
import { Pressable } from "@/components/ui/pressable";
import { useUiLocale } from "@/lib/i18n-format";
import { Phrase, PhraseWithArgs, phraseText } from "@/lib/i18n-phrase";
import {
  RESEARCH_PHASE_UI,
  isTerminalPhase,
  isWorkingPhase,
  researchPacingState,
  researchPhaseOfSubject,
} from "@/lib/research/phase";
import { RUN_PACING, createPhasePacer } from "@/lib/run/pacer";
import { claimLoop } from "@/lib/run/store";
import type { PhaseState, PhraseLine } from "@/lib/run/types";
import { cn } from "@/lib/utils";
import type { ResearchPhase } from "@/types/research";

/*
 * A run's one line in the transcript (SPEC §9.11.3, DECISIONS R4):
 *
 *   [glyph] {phase sentence}   {favicons ≤3} · N sources      {clock}   Open ›
 *
 * Not a console: no tabs, no stage spine, no log. The whole row is one press
 * target that opens the Research panel, with a stable accessible name
 * ("Research. {phase}. N sources. Open research panel") that changes once per
 * phase, not per poll. It reuses the chat run's parts — the glyph, the label,
 * the favicon stack, the clock and the pacer — so a research run and a chat
 * turn read as the same kind of thing.
 *
 * - The glyph is calm from the start (runs are long) and joins the loop
 *   arbiter at priority 4, so it loops only when nothing else on screen does.
 * - The clock is the DTO's `workingMs`, counted forward from the fetch while
 *   the run works and held still at gates and while paused (bug 9).
 * - The count is pages read while live and sources cited at rest (bug 11).
 * - Below a 28rem container the favicons and the count leave the row; both
 *   are in the accessible name.
 * - On completion it does not unmount: it swaps in place, at the same 2.25rem,
 *   to "Report ready · Open report ›".
 *
 * The scope card owns planning and the plan gate, so the row renders nothing
 * until the run has started; integration can place both for every run.
 */

type ResearchView = Extract<RightPanelState, { kind: "research" }>["view"];

export interface ResearchRowProps {
  runId: string;
  /** Opens the Research panel on this run ("progress" while live, "report" once done). */
  onOpen(runId: string, view: ResearchView): void;
}

/** The attribute a row carries, so focus can be moved to it after Start (research-UI bug 12). */
export const RESEARCH_ROW_ATTR = "data-research-row";

/**
 * Moves focus to a run's row. The row mounts when the run leaves the gate, a
 * poll or two after Start, so this waits for it (up to ~3 s) rather than
 * giving up on the first frame.
 */
export function focusResearchRow(runId: string, attempts = 30): void {
  if (typeof document === "undefined") return;
  const row = document.querySelector<HTMLElement>(`[${RESEARCH_ROW_ATTR}="${CSS.escape(runId)}"]`);
  if (row) {
    row.focus();
    return;
  }
  if (attempts > 0) window.setTimeout(() => focusResearchRow(runId, attempts - 1), 100);
}

/**
 * Research runs poll every few seconds: a label must stay long enough to read
 * (§9.11.1), and a row mounts with its phase already known, so nothing is held
 * back at the start. (`RUN_PACING` is declared `as const`, so its partial type
 * names the default values; the override is widened to it here.)
 */
const RESEARCH_PACING = { dwellMs: 1_500, glyphDelayMs: 0, showDelayMs: 0 } as unknown as Partial<typeof RUN_PACING>;

/**
 * The phase the row shows, through the shared pacer: the newest phase always
 * wins, but a label is held long enough to be read. The pacer speaks the chat
 * run's phases; the Research phase and its query or domain ride in the
 * subject key and are read back from it.
 */
function usePacedPhase(phase: ResearchPhase | null, detail: { query?: string; domain?: string } | null | undefined) {
  const [paced, setPaced] = React.useState<PhaseState | null>(null);
  const pacer = React.useRef<ReturnType<typeof createPhasePacer> | null>(null);

  React.useEffect(() => {
    const next = createPhasePacer((state: PhaseState) => setPaced(state), RESEARCH_PACING);
    pacer.current = next;
    return () => {
      next.dispose();
      if (pacer.current === next) pacer.current = null;
    };
  }, []);

  const query = detail?.query;
  const domain = detail?.domain;
  React.useEffect(() => {
    if (phase) pacer.current?.push(researchPacingState(phase, { query, domain }));
  }, [phase, query, domain]);

  const shownPhase = researchPhaseOfSubject(paced?.subjectKey) ?? phase;
  const subjectKey = paced?.subjectKey ?? (phase ? `${phase}:` : "");
  return { phase: shownPhase, subjectKey };
}

/** The line for a paced phase, with the subject (query or domain) it was pushed with. */
function pacedLine(phase: ResearchPhase, subjectKey: string): PhraseLine {
  const subject = subjectKey.slice(subjectKey.indexOf(":") + 1);
  const detail = phase === "searching" ? { query: subject } : phase === "reading" ? { domain: subject } : null;
  return RESEARCH_PHASE_UI[phase].line({ phaseDetail: subject ? detail : null });
}

export function ResearchRow({ runId, onOpen }: ResearchRowProps) {
  const { run, phase, fetchedAt } = useResearchRun(runId);
  const locale = useUiLocale();
  const paced = usePacedPhase(phase, run?.phaseDetail);
  const loopId = `research-row:${runId}`;
  const working = !!phase && isWorkingPhase(phase);

  // Priority 4: the newest live Research row, below every chat surface (§7.9.1).
  React.useEffect(() => {
    if (!working) return;
    return claimLoop(loopId, 4);
  }, [loopId, working]);

  if (!run || !phase || phase === "planning" || phase === "awaiting_start") return null;

  const terminal = isTerminalPhase(phase);
  // A terminal phase is shown at once; the pacer skips its dwell anyway.
  const shown = terminal ? phase : (paced.phase ?? phase);
  const ready = phase === "done" && !!run.report;
  const line = shown === phase ? rowLine(phase, run) : pacedLine(shown, paced.subjectKey);
  const count = rowSourceCount(run, phase);
  const favicons = rowFavicons(run);
  const clock = researchClock(run, phase, fetchedAt);
  const view = rowOpensView(phase, run);
  // A stable noun phrase: built from the phase, never from the ticking parts.
  const name = phraseText(rowNameLine(shown, run, count), locale);

  return (
    <div className="@container/research-row [--fav-ring:var(--background)]">
      <Pressable
        kind="row"
        {...{ [RESEARCH_ROW_ATTR]: runId }}
        data-phase={phase}
        aria-label={name}
        data-no-auto-translate
        onClick={() => onOpen(runId, view)}
        className="h-9 min-h-9 gap-2.5 rounded-control px-2 py-0 leading-6 coarse:h-11 coarse:min-h-11"
      >
        <RunGlyph phase={RESEARCH_PHASE_UI[shown].glyph} calm loopId={loopId} />
        <span aria-hidden className="min-w-0 flex-1">
          <RunLabel
            line={line}
            motionKey={terminal ? phase : paced.subjectKey}
            live={!terminal}
            calm
            loopId={loopId}
            className={cn("block min-w-0", terminal && "text-ui font-medium text-foreground/80")}
          />
        </span>
        {!ready && (
          <span
            aria-hidden
            className="hidden shrink-0 items-center gap-1.5 font-mono text-caption tabular-nums text-muted-foreground @[28rem]/research-row:inline-flex"
          >
            {favicons.length > 0 && <FaviconStack sources={favicons} />}
            {count > 0 && <PhraseWithArgs spec={sourcesCount(count)} />}
          </span>
        )}
        {!ready && (
          <RunClock
            elapsedMs={clock.elapsedMs}
            since={clock.since}
            showAfterMs={0}
            className="run-clock shrink-0 font-mono text-caption text-muted-foreground"
          />
        )}
        <span aria-hidden className="inline-flex shrink-0 items-center gap-0.5 text-caption text-muted-foreground">
          <Phrase text={ready ? RESEARCH_COPY.row.openReport : RESEARCH_COPY.row.open} />
          {/* An icon, never a "›" in the copy; it points the reading direction. */}
          <ChevronRight className="size-3.5 rtl:-scale-x-100" />
        </span>
      </Pressable>
    </div>
  );
}

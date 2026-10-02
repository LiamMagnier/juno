/**
 * Research phases as the reader sees them (SPEC §9.11.1). The server derives
 * `dto.phase`; the client maps it to a glyph and a line with one table.
 * `derivePhase` (chat-only) is not used here; only the pacer is shared.
 *
 * WS0 landed the types and the glyph column, which the spec fixes; the lines
 * are written from `RESEARCH_COPY`, so every word is a catalog phrase and the
 * query or domain a line names rides beside it as an argument node.
 *
 * Two helpers sit beside the table because every Research surface needs them:
 * `phaseOfRun`, the phase of a run whose server predates `dto.phase` (the
 * field is optional on the wire, and a run written before the rework has
 * none), and `researchPacingState`, the run's phase in the shape the shared
 * pacer takes.
 */

import { RESEARCH_COPY } from "@/components/research/copy";
import type { ResearchEventDTO } from "@/lib/research/domain";
import type { PhaseState, PhraseLine, RunPhase } from "@/lib/run/types";
import type { ResearchPhase, ResearchRunViewAdditions } from "@/types/research";

export type { ResearchPhase } from "@/types/research";

export interface ResearchPhaseUi {
  glyph: RunPhase | "paused";
  /** The phase sentence; reads `phaseDetail` for the query or domain it names. */
  line(run: ResearchRunViewAdditions): PhraseLine;
}

const P = RESEARCH_COPY.phase;

const only = (text: string) => (): PhraseLine => [{ parts: [{ phrase: text }] }];

export const RESEARCH_PHASE_UI: Record<ResearchPhase, ResearchPhaseUi> = {
  planning: { glyph: "thinking", line: only(P.planning) },
  awaiting_start: { glyph: "waiting", line: only(P.awaitingStart) },
  searching: {
    glyph: "searching",
    line: (run) => {
      const query = run.phaseDetail?.query?.trim();
      return query ? [{ parts: [{ phrase: P.searchingFor }, { kind: "quote", value: query }] }] : [{ parts: [{ phrase: P.searching }] }];
    },
  },
  reading: {
    glyph: "reading",
    line: (run) => {
      const domain = run.phaseDetail?.domain?.trim();
      return domain ? [{ parts: [{ phrase: P.reading }, { kind: "domain", value: domain }] }] : [{ parts: [{ phrase: P.readingSources }] }];
    },
  },
  reviewing: { glyph: "thinking", line: only(P.reviewing) },
  writing: { glyph: "writing", line: only(P.writing) },
  checking: { glyph: "writing", line: only(P.checking) },
  paused: { glyph: "paused", line: only(P.paused) },
  done: { glyph: "done", line: only(P.done) },
  stopped: { glyph: "stopped", line: only(P.stopped) },
  failed: { glyph: "failed", line: only(P.failed) },
};

export const RESEARCH_PHASES = Object.keys(RESEARCH_PHASE_UI) as ResearchPhase[];

/** Phases in which the run is spending: its glyph may loop and its clock runs. */
const WORKING_PHASES = new Set<ResearchPhase>(["planning", "searching", "reading", "reviewing", "writing", "checking"]);
const TERMINAL_PHASES = new Set<ResearchPhase>(["done", "stopped", "failed"]);

export function isWorkingPhase(phase: ResearchPhase): boolean {
  return WORKING_PHASES.has(phase);
}

export function isTerminalPhase(phase: ResearchPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

export function isResearchPhase(value: unknown): value is ResearchPhase {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(RESEARCH_PHASE_UI, value);
}

/**
 * The run's phase: the server's `phase` when it sent one, else derived from
 * the state (and, while investigating, from the newest search or page read in
 * the events the client holds). A state this build does not know reads as
 * `failed` rather than as working: a row that claims to be busy forever is
 * worse than one that admits it stopped.
 */
export function phaseOfRun(
  run: { state: string; phase?: unknown; report?: string | null },
  events: readonly Pick<ResearchEventDTO, "kind">[] = [],
): ResearchPhase {
  if (isResearchPhase(run.phase)) return run.phase;
  switch (run.state) {
    case "accepted":
    case "clarifying":
    case "planning":
      return "planning";
    case "awaiting_clarification":
    case "awaiting_plan_confirmation":
    case "awaiting_user_input":
      return "awaiting_start";
    case "investigating": {
      for (let i = events.length - 1; i >= 0; i--) {
        const kind = events[i].kind;
        if (kind === "source_read" || kind === "page_summarized") return "reading";
        if (kind === "query_issued") return "searching";
      }
      return "searching";
    }
    case "reviewing":
      return "reviewing";
    case "synthesizing":
      return "writing";
    case "validating_citations":
      return "checking";
    case "paused":
      return "paused";
    case "completed":
      return "done";
    case "partially_completed":
      // Stopped early with usable material: a report is a report.
      return run.report ? "done" : "stopped";
    case "cancelled":
      return "stopped";
    default:
      return "failed";
  }
}

/**
 * The run's phase in the shape `createPhasePacer` paces (§7.3). Research has
 * no `RunPhase` of its own for a gate or a pause, so both map to the phases
 * that skip the dwell ("waiting", and the terminal three): a person who pressed
 * Pause should see it at once. The subject key carries the Research phase and
 * the query or domain, so a new query under the same phase swaps the label on
 * the pacer's same-subject rule, and the label can be looked up again from it.
 */
export function researchPacingState(phase: ResearchPhase, detail?: { query?: string; domain?: string } | null): PhaseState {
  const glyph = RESEARCH_PHASE_UI[phase].glyph;
  const paced: RunPhase = glyph === "paused" ? "waiting" : glyph;
  const subject = detail?.query ?? detail?.domain ?? "";
  return {
    phase: paced,
    subjectKey: `${phase}:${subject}`,
    stalled: false,
    // Runs are long: calm from the start (§9.14).
    calm: true,
    escalation: 0,
  };
}

/** The Research phase a paced state was built from (the inverse of the subject key above). */
export function researchPhaseOfSubject(subjectKey: string | undefined): ResearchPhase | null {
  if (!subjectKey) return null;
  const at = subjectKey.indexOf(":");
  const phase = at === -1 ? subjectKey : subjectKey.slice(0, at);
  return isResearchPhase(phase) ? phase : null;
}

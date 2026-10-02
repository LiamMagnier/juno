/**
 * Research phases as the reader sees them (SPEC §9.11.1). The server derives
 * `dto.phase`; the client maps it to a glyph and a line with one table.
 * `derivePhase` (chat-only) is not used here; only the pacer is shared.
 *
 * WS0 lands the types and the glyph column, which the spec fixes; WS8 owns the
 * table after and writes the lines from `RESEARCH_COPY`.
 */

import type { PhraseLine, RunPhase } from "@/lib/run/types";
import type { ResearchPhase, ResearchRunViewAdditions } from "@/types/research";

export type { ResearchPhase } from "@/types/research";

export interface ResearchPhaseUi {
  glyph: RunPhase | "paused";
  /** The phase sentence; reads `phaseDetail` for the query or domain it names. */
  line(run: ResearchRunViewAdditions): PhraseLine;
}

function unwritten(): PhraseLine {
  throw new Error("not implemented: WS8");
}

export const RESEARCH_PHASE_UI: Record<ResearchPhase, ResearchPhaseUi> = {
  planning: { glyph: "thinking", line: unwritten },
  awaiting_start: { glyph: "waiting", line: unwritten },
  searching: { glyph: "searching", line: unwritten },
  reading: { glyph: "reading", line: unwritten },
  reviewing: { glyph: "thinking", line: unwritten },
  writing: { glyph: "writing", line: unwritten },
  checking: { glyph: "writing", line: unwritten },
  paused: { glyph: "paused", line: unwritten },
  done: { glyph: "done", line: unwritten },
  stopped: { glyph: "stopped", line: unwritten },
  failed: { glyph: "failed", line: unwritten },
};

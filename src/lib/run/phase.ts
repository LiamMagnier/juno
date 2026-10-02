/**
 * Which phase a chat run is in, from its view and the stream's live state
 * (SPEC §7.3). Chat only: Research's phase comes from the server DTO through
 * `src/lib/research/phase.ts`, and only the pacer is shared.
 *
 * First match wins:
 *   1. not streaming → failed | stopped | done;
 *   2. a call awaits approval → waiting;
 *   3. a call runs or is queued → searching | reading | tool, by the most
 *      recently started one;
 *   4. answer text was flushed → answering (a later call re-enters rule 3);
 *   5. the latest round has a reasoning segment → thinking;
 *   6. otherwise queued for the first 400 ms, then thinking.
 *
 * Pure: every clock reading arrives in `live`.
 */

import { RUN_PACING } from "@/lib/motion";
import { instant } from "@/lib/run/timeline";
import type { PhaseInputs, PhaseState, RunItem, RunPhase, RunView } from "@/lib/run/types";
import type { CanonicalToolId } from "@/types/run";

export type { PhaseInputs, PhaseState, RunPhase } from "@/lib/run/types";

type ToolItem = Extract<RunItem, { kind: "tool" }>;

const SEARCHING: ReadonlySet<CanonicalToolId> = new Set(["web_search", "provider_web_search", "provider_x_search", "search_chats"]);
const READING: ReadonlySet<CanonicalToolId> = new Set(["web_fetch", "read_document", "inspect_image"]);

/** The phase a running call puts the line in. */
export function phaseForTool(tool: CanonicalToolId): "searching" | "reading" | "tool" {
  if (SEARCHING.has(tool)) return "searching";
  if (READING.has(tool)) return "reading";
  return "tool";
}

function startOf(item: ToolItem): number {
  return instant(item.call.startedAt) ?? 0;
}

/** The most recently started of the active calls; the higher seq breaks a tie. */
function newest(items: readonly ToolItem[]): ToolItem {
  return items.reduce((best, item) => {
    const a = startOf(item);
    const b = startOf(best);
    return a > b || (a === b && item.seq > best.seq) ? item : best;
  });
}

interface DeriveOptions {
  coalesceWindowMs?: number;
  showDelayMs?: number;
  calmAfterMs?: number;
  stalledAfterMs?: number;
  escalateAfterMs?: number;
  escalateAgainAfterMs?: number;
}

export function derivePhase(view: RunView, live: PhaseInputs, options: DeriveOptions = {}): PhaseState {
  const pacing = { ...RUN_PACING, ...options };
  const now = live.now;

  // 1. The stream is over.
  if (!live.streaming) {
    const phase: RunPhase =
      live.finishReason === "user_stopped" ? "stopped" : live.error ? "failed" : "done";
    return { phase, stalled: false, calm: false, escalation: 0 };
  }

  const active = view.tools.filter((item) => item.call.status === "running" || item.call.status === "queued");
  const waiting = view.tools.filter((item) => item.call.status === "awaiting_approval");

  let phase: RunPhase;
  let subjectKey: string | undefined;
  let coalesced: number | undefined;

  if (waiting.length) {
    // 2. The turn is blocked on the reader.
    const item = newest(waiting);
    phase = "waiting";
    subjectKey = item.key;
  } else if (active.length) {
    // 3. A call is working: its kind names the phase.
    const latest = newest(active);
    phase = phaseForTool(latest.call.tool);
    subjectKey = latest.key;
    if (phase !== "tool") {
      // Reads (or searches) that started together read as one step: "Reading 3 sources".
      const batch = active.filter(
        (item) =>
          phaseForTool(item.call.tool) === phase && Math.abs(startOf(item) - startOf(latest)) <= pacing.coalesceWindowMs,
      );
      if (batch.length > 1) {
        coalesced = batch.length;
        // Stable for the whole batch, so a new member updates the count without swapping the label.
        subjectKey = `batch:${batch.reduce((first, item) => (item.seq < first.seq ? item : first)).key}`;
      }
    }
  } else if (live.answerStarted) {
    // 4. The chat line settles at the first answer text. It never says "Writing" (DECISIONS §4b).
    phase = "answering";
  } else {
    // 5–6. Thinking: named by the latest round's segment when it has one.
    const latestRound = view.items.reduce((max, item) => ("round" in item ? Math.max(max, item.round) : max), 0);
    const segment = [...view.items]
      .reverse()
      .find((item): item is Extract<RunItem, { kind: "reasoning" }> => item.kind === "reasoning" && item.round === latestRound);
    if (segment) {
      phase = "thinking";
      subjectKey = segment.key;
    } else {
      phase = now - live.startedAt < pacing.showDelayMs ? "queued" : "thinking";
    }
  }

  if (phase === "answering" || phase === "waiting") {
    return { phase, ...(subjectKey ? { subjectKey } : {}), stalled: false, calm: false, escalation: 0 };
  }

  // Working time since the last break: the send, the reader's last approval decision, or — after
  // the answer began — the start of the call that re-entered.
  let workingSince = live.startedAt;
  for (const item of view.tools) {
    const decided = instant(item.call.approval?.decidedAt ?? null);
    if (decided !== null && decided > workingSince && decided <= now) workingSince = decided;
  }
  if (live.answerStarted && active.length) {
    workingSince = Math.max(workingSince, Math.min(...active.map(startOf)));
  }
  const workingMs = Math.max(0, now - workingSince);

  // A call inside its own timeout is working even when it sends nothing (a 60 s run_code, INV-33).
  const withinTimeout = view.tools.some((item) => {
    if (item.call.status !== "running") return false;
    if (!item.call.timeoutMs) return true;
    return now - startOf(item) < item.call.timeoutMs;
  });
  const stalled = now - live.lastEventAt >= pacing.stalledAfterMs && !withinTimeout;
  const calm = stalled || workingMs >= pacing.calmAfterMs;
  const escalation: 0 | 1 | 2 =
    workingMs >= pacing.escalateAgainAfterMs ? 2 : workingMs >= pacing.escalateAfterMs ? 1 : 0;

  return {
    phase,
    ...(subjectKey ? { subjectKey } : {}),
    stalled,
    calm,
    escalation,
    ...(coalesced ? { coalesced } : {}),
    workingMs,
    ...(stalled ? { stalledSince: live.lastEventAt } : {}),
  };
}

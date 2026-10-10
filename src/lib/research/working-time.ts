import "server-only";
import { prisma } from "@/lib/prisma";
import type { ResearchPlan } from "@/lib/research/domain";
import { refreshResearchFactsWith, type ResearchRunLookup } from "@/lib/research/message-time";
import { activeWorkingMs, workingMsOf } from "@/lib/research/view";
import type { ClientActivityEvent } from "@/types/chat";

/**
 * How long a research run worked, read from the run itself.
 *
 * Its own module (not run.ts) because the message serializer needs it too,
 * and run.ts carries the whole engine with it.
 */

interface RunClockRow {
  id: string;
  userId: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  state: string;
}

/** A state_changed payload's new state, or null. */
function movedTo(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const state = (payload as Record<string, unknown>).state;
  return typeof state === "string" ? state : null;
}

/**
 * Time the run spent working, from its own event log (`activeWorkingMs`):
 * startedAt to the finish (or now), with the plan gate, pauses and every
 * stretch nobody was driving it left out. Falls back to the plan's clock only
 * when the log cannot be read.
 */
export async function runWorkingMs(run: RunClockRow, plan: ResearchPlan, now: Date): Promise<number> {
  const end = run.finishedAt ?? now;
  try {
    const [stamps, moves] = await Promise.all([
      prisma.researchEvent.findMany({
        where: { runId: run.id, userId: run.userId },
        orderBy: { seq: "asc" },
        select: { seq: true, createdAt: true },
      }),
      prisma.researchEvent.findMany({
        where: { runId: run.id, userId: run.userId, kind: "state_changed" },
        select: { seq: true, payload: true },
      }),
    ]);
    if (stamps.length === 0) return workingMsOf(run, plan, now);
    const moved = new Map<number, string>();
    for (const move of moves) {
      const state = movedTo(move.payload);
      if (state) moved.set(move.seq, state);
    }
    return activeWorkingMs({
      startedAt: run.startedAt ?? run.createdAt,
      end,
      events: stamps.map((stamp) => ({ at: stamp.createdAt, state: moved.get(stamp.seq) ?? null })),
    });
  } catch (error) {
    console.error("[research] working time from events failed", { runId: run.id, error });
    return workingMsOf(run, plan, now);
  }
}

const lookupRun: ResearchRunLookup = (runId, conversationId) =>
  prisma.researchRun.findFirst({
    where: { id: runId, conversationId },
    select: { id: true, userId: true, createdAt: true, startedAt: true, finishedAt: true, state: true, plan: true },
  });

/** `refreshResearchFactsWith` on the database: what `serializeMessage` calls. */
export function refreshResearchFacts(
  activity: ClientActivityEvent[] | undefined,
  conversationId: string
): Promise<ClientActivityEvent[] | undefined> {
  return refreshResearchFactsWith(activity, conversationId, { lookup: lookupRun, workingMs: runWorkingMs });
}

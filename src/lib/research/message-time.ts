import { parsePlan, type ResearchPlan } from "@/lib/research/domain";
import type { ClientActivityEvent } from "@/types/chat";

/**
 * The "Researched for" a message shows, recalculated from its run. Pure (the
 * lookup and the clock are injected) so it is tested without a database;
 * `working-time.ts` binds it to Prisma for the serializer.
 */

export interface MessageRunClock {
  id: string;
  userId: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  state: string;
  plan: unknown;
}

/** Looks a run up for the messages of one conversation; null when it is gone. */
export type ResearchRunLookup = (runId: string, conversationId: string) => Promise<MessageRunClock | null>;
export type RunWorkingMs = (run: MessageRunClock, plan: ResearchPlan, now: Date) => Promise<number>;

/**
 * A research message stores the run's working time in its activity fact when
 * the run completes, and messages written before the clock fix stored wall
 * clock ("30h 27m" for a fifteen-minute run). So the stored figure is never
 * shown: each research fact's `workedMs` is replaced with the run's working
 * time as the run itself records it, and with 0 (which every surface reads as
 * "no time") when the run cannot be found. Web and native both read messages
 * through the serializer, so both get the recalculated figure.
 */
export async function refreshResearchFactsWith(
  activity: ClientActivityEvent[] | undefined,
  conversationId: string,
  deps: { lookup: ResearchRunLookup; workingMs: RunWorkingMs; now?: Date }
): Promise<ClientActivityEvent[] | undefined> {
  if (!activity?.some((event) => event.fact?.key === "research")) return activity;
  const now = deps.now ?? new Date();
  const times = new Map<string, number>();
  for (const event of activity) {
    const fact = event.fact;
    if (fact?.key !== "research" || times.has(fact.runId)) continue;
    let ms = 0;
    try {
      const run = await deps.lookup(fact.runId, conversationId);
      if (run) ms = await deps.workingMs(run, parsePlan(run.plan), now);
    } catch (error) {
      console.error("[research] could not recalculate a message's working time", { runId: fact.runId, error });
    }
    times.set(fact.runId, Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0);
  }
  return activity.map((event) =>
    event.fact?.key === "research" ? { ...event, fact: { ...event.fact, workedMs: times.get(event.fact.runId) ?? 0 } } : event
  );
}

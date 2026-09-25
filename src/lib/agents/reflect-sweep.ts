import "server-only";

/**
 * The reflection sweep: proactive agents thinking between visits.
 *
 * Without it an agent only reflects when its page is opened, so the one whose
 * person is away — the one with the most to catch up on — never does. The loop
 * is scripts/agent-reflector.ts; this is what one tick does.
 *
 * Bounded like the dreamer (src/lib/memory-dreamer.ts), because it is the same
 * kind of thing: an unattended model call billed to someone's account.
 * **Who**: a proactive, active agent whose last reflection is past the
 * interval, whose person has chatted in the last two weeks, and that has
 * something to think about (an active goal, or a task in the same two weeks).
 * **How many**: `AGENT_SWEEP_PER_TICK` reflections a tick, at most
 * `AGENT_SWEEP_PER_ACCOUNT` of them for one account. **Money**: each account's
 * usage windows are checked once a tick, before anything is claimed; an
 * account out of window is left for a later tick, not marked as reflected.
 * Everything after the one cross-account query goes through `reflectAgent`,
 * which claims the agent (so a page opening at the same moment cannot pay
 * twice) and reads and writes through the guarded client like any request.
 */

import { Prisma } from "@prisma/client";
import { prismaUnguarded } from "@/lib/prisma";
import type { UtilityLlm } from "@/lib/memory";
import { AGENT_REFLECT_INTERVAL_MS } from "@/lib/agents/domain";
import { reflectAgent } from "@/lib/agents/reflect";
import { checkUsageWindows } from "@/lib/spend";
import { getUserPlan } from "@/lib/usage";

/** How often the reflector wakes. Far below the six-hour interval, so a due agent waits minutes, not hours. */
export const AGENT_SWEEP_INTERVAL_MS = 10 * 60_000;
/** The pause before the first tick, so a deploy's restart does not spend while the web app is still coming up. */
export const AGENT_SWEEP_FIRST_TICK_MS = 30_000;
/** Reflections one tick may run: each is a model call. */
export const AGENT_SWEEP_PER_TICK = 8;
/** Of those, how many may be one account's, so a team of 24 agents cannot take every tick. */
export const AGENT_SWEEP_PER_ACCOUNT = 2;
/**
 * Candidates read per reflection allowed: an account out of its usage window
 * keeps its agents at the head of the queue (they are never claimed), and the
 * spare candidates are what lets everyone behind them still be reached.
 */
const CANDIDATES_PER_REFLECTION = 3;
/**
 * How recently the person must have chatted, and an agent worked, for a
 * reflection to be worth paying for. Past it the ideas would pile up unread.
 */
export const AGENT_SWEEP_ACTIVE_DAYS = 14;

export interface AgentToReflect {
  agentId: string;
  userId: string;
}

/**
 * The agents due a reflection, oldest reflection first (never-reflected ahead
 * of all), at most `AGENT_SWEEP_PER_ACCOUNT` per account.
 *
 * The ONE query here that looks across accounts, so it is the one that uses
 * `prismaUnguarded` and it returns ids and nothing else. Raw SQL because the
 * "has worked recently" test joins `WorkSession.agentId`, which is a plain
 * column rather than a relation. Every clause has an index behind it: the
 * conversation test is `Conversation(userId, lastMessageAt)`, the goal test
 * `AgentGoal(agentId, status, createdAt)`, the task test
 * `WorkSession(userId, agentId, lastActivityAt)`; the agent table itself is
 * small (24 per account at most).
 */
export async function findAgentsToReflect(now: Date, limit: number): Promise<AgentToReflect[]> {
  const dueBefore = new Date(now.getTime() - AGENT_REFLECT_INTERVAL_MS);
  const activeSince = new Date(now.getTime() - AGENT_SWEEP_ACTIVE_DAYS * 86_400_000);
  const rows = await prismaUnguarded.$queryRaw<{ id: string; userId: string }[]>(Prisma.sql`
    SELECT ranked."id", ranked."userId"
    FROM (
      SELECT a."id", a."userId", a."lastReflectedAt",
        ROW_NUMBER() OVER (PARTITION BY a."userId" ORDER BY a."lastReflectedAt" ASC NULLS FIRST, a."id") AS "place"
      FROM "Agent" a
      JOIN "User" u ON u."id" = a."userId"
      WHERE a."deletedAt" IS NULL
        AND a."status" = 'active'
        AND a."proactive" = true
        AND (a."lastReflectedAt" IS NULL OR a."lastReflectedAt" < ${dueBefore})
        AND u."bannedAt" IS NULL
        AND EXISTS (
          SELECT 1 FROM "Conversation" c
          WHERE c."userId" = a."userId" AND c."lastMessageAt" > ${activeSince}
        )
        AND (
          EXISTS (
            SELECT 1 FROM "AgentGoal" g
            WHERE g."agentId" = a."id" AND g."status" = 'active'
          )
          OR EXISTS (
            SELECT 1 FROM "WorkSession" w
            WHERE w."userId" = a."userId" AND w."agentId" = a."id" AND w."deletedAt" IS NULL
              AND w."status" <> 'draft' AND w."lastActivityAt" > ${activeSince}
          )
        )
    ) ranked
    WHERE ranked."place" <= ${AGENT_SWEEP_PER_ACCOUNT}
    ORDER BY ranked."lastReflectedAt" ASC NULLS FIRST, ranked."id"
    LIMIT ${limit}
  `);
  return rows.map((row) => ({ agentId: row.id, userId: row.userId }));
}

/** What one tick did, as counts: the log line is made of these and nothing else. */
export interface AgentSweepOutcome {
  /** Agents the query offered. */
  considered: number;
  reflected: number;
  /** Ideas raised across those reflections. */
  ideas: number;
  /** Agents whose account was out of its usage windows, left unclaimed for a later tick. */
  deferred: number;
  /** Reflections `reflectAgent` itself declined: claimed by a page meanwhile, paused, no answer. */
  skipped: number;
  failed: number;
}

/**
 * One tick: find the due agents, gate each account once on its usage windows,
 * and reflect the rest as the sweep (`origin: "sweep"`, the one origin that
 * announces its ideas). Stops early, between agents, when `shouldStop` says
 * the process is shutting down.
 */
export async function sweepAgentReflections(
  options: { now?: Date; limit?: number; llm?: UtilityLlm; shouldStop?: () => boolean } = {}
): Promise<AgentSweepOutcome> {
  const now = options.now ?? new Date();
  const limit = Math.max(1, options.limit ?? AGENT_SWEEP_PER_TICK);
  const outcome: AgentSweepOutcome = { considered: 0, reflected: 0, ideas: 0, deferred: 0, skipped: 0, failed: 0 };

  const candidates = await findAgentsToReflect(now, limit * CANDIDATES_PER_REFLECTION);
  outcome.considered = candidates.length;

  // Asked once per account per tick, the way the dreamer asks: the same read
  // a chat turn is gated on, so the sweep can never spend what a person could
  // not. Remembered, because an account's agents arrive one after another.
  const allowed = new Map<string, boolean>();
  let attempted = 0;
  for (const { agentId, userId } of candidates) {
    if (attempted >= limit || options.shouldStop?.()) break;
    try {
      let inWindow = allowed.get(userId);
      if (inWindow === undefined) {
        inWindow = (await checkUsageWindows(userId, await getUserPlan(userId), null, undefined, { now })).allowed;
        allowed.set(userId, inWindow);
      }
      if (!inWindow) {
        outcome.deferred++;
        continue;
      }
      attempted++;
      const result = await reflectAgent({ id: userId }, agentId, { now, origin: "sweep", llm: options.llm });
      if (result.kind === "reflected") {
        outcome.reflected++;
        outcome.ideas += result.ideas;
      } else {
        outcome.skipped++;
      }
    } catch (error) {
      // One agent's failure is that agent's; the tick moves on. Ids only.
      outcome.failed++;
      console.error(
        `[agent-reflector] agent=${agentId} account=${userId} failed:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  return outcome;
}

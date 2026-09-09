import { prismaUnguarded } from "@/lib/db";
import { appendTaskEvents } from "@/lib/code-task-events";
import { selectStuckTasks, sweepCutoff, SWEEPABLE_STATUSES } from "@/lib/stuck-task-sweeper";

/**
 * The sweep itself: find Juno Code tasks whose runner died without saying so,
 * and move them out of `running`.
 *
 * WHY THIS FILE EXISTS. The policy (`stuck-task-sweeper.ts`) was written,
 * documented and unit-tested, and the worker that applies it lived entirely
 * inside `scripts/sweep-stuck-code-tasks.ts` — a file with a top-level `main()`
 * that cannot be imported. Its only caller was a manual npm script, and there
 * is no cron in the deployment (`render.yaml` defines the voice relay and
 * nothing else). So in production the sweep never ran: the case the whole
 * module was written for — the runner is gone — was never actually reconciled.
 * A killed run stayed `running` forever, showing a spinner to its owner and
 * staying invisible to every "what failed" query.
 *
 * The logic is unchanged. It is only lifted out of the script's module scope so
 * that the server can call it too.
 *
 * This module is database-only on purpose: no `next/server`, no session, no
 * React server condition, so the plain-Node worker can still import it.
 */
export interface SweepResult {
  examined: number;
  presumedDead: number;
  reconciled: number;
  failed: number;
}

export async function sweepStuckCodeTasks(
  opts: { dry?: boolean; log?: (line: string) => void } = {},
): Promise<SweepResult> {
  const { dry = false, log } = opts;
  const now = new Date();
  const candidates = await prismaUnguarded.codeTask.findMany({
    where: {
      status: { in: [...SWEEPABLE_STATUSES] },
      updatedAt: { lt: sweepCutoff(now) },
    },
    select: {
      id: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      runnerClaimedAt: true,
      target: true,
    },
    // Bounded: a backlog is worked through over successive runs rather than in
    // one transaction that holds locks across thousands of rows.
    take: 500,
    orderBy: { updatedAt: "asc" },
  });

  const stuck = selectStuckTasks(candidates, now);
  log?.(
    `[sweep] ${candidates.length} silent task(s) examined, ${stuck.length} presumed dead` +
      (dry ? " — DRY RUN, nothing will be written" : ""),
  );

  let reconciled = 0;
  let failed = 0;
  for (const { task, verdict } of stuck) {
    log?.(`[sweep] ${task.id} (${task.status}, ${task.target}) → failed: ${verdict.reason}`);
    if (dry) continue;
    try {
      // Through `appendTaskEvents` rather than a bare status update, so the
      // reason lands in the transcript the user is actually looking at — and so
      // `fromStatus` makes the transition conditional: a runner that comes back
      // to life in the same instant and posts its own terminal status wins,
      // rather than being overwritten by this.
      await appendTaskEvents(
        task.id,
        [
          {
            kind: "error",
            payload: { message: verdict.message ?? "The runner stopped reporting." },
            key: `sweeper:${task.id}:${verdict.reason}`,
          },
        ],
        { status: "failed", fromStatus: task.status },
      );
      reconciled += 1;
    } catch (err) {
      failed += 1;
      log?.(
        `[sweep] ${task.id} could not be reconciled: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { examined: candidates.length, presumedDead: stuck.length, reconciled, failed };
}

/** How often an opportunistic sweep may run in one server instance. */
const OPPORTUNISTIC_INTERVAL_MS = 10 * 60 * 1000;
let lastOpportunisticSweep = 0;
let sweepInFlight: Promise<unknown> | null = null;

/**
 * Run the sweep from inside a request, at most once every ten minutes per
 * instance, never blocking the response.
 *
 * WHY OPPORTUNISTIC AND NOT A CRON. There is no scheduler in this deployment to
 * hang it on, and inventing one — a maintenance route plus a shared secret plus
 * a scheduled workflow to call it — is three new pieces of trusted surface for
 * a query that returns nothing almost every time it runs. Hanging it off a
 * route that is already polled means it runs wherever the app runs.
 *
 * The throttle is per instance, so a fleet sweeps more often than every ten
 * minutes. That is fine and deliberate: the query is a single indexed range
 * read that normally matches zero rows, and every write it can make is
 * idempotent — `appendTaskEvents` dedupes on the event key, and the status
 * transition is conditional on the status it read.
 */
export function sweepStuckCodeTasksOpportunistically(): Promise<unknown> {
  const now = Date.now();
  if (sweepInFlight) return sweepInFlight;
  if (now - lastOpportunisticSweep < OPPORTUNISTIC_INTERVAL_MS) return Promise.resolve();
  lastOpportunisticSweep = now;
  sweepInFlight = sweepStuckCodeTasks({
    log: (line) => console.log(line),
  })
    .catch((err) => {
      // Never surfaced to the caller: this is maintenance riding along on
      // someone else's request, and it must not change what they see.
      console.error("[sweep] opportunistic run failed", err);
    })
    .finally(() => {
      sweepInFlight = null;
    });
  return sweepInFlight;
}

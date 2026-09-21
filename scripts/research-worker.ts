/**
 * Restart-safe durable research executor.
 *
 * The API can nudge a run immediately, but it cannot be the only driver: a
 * process restart between two research stages must not strand a paid run in a
 * live state. This worker claims accepted/working rows through the same
 * conditional lease used by the engine, then drives each one until it blocks
 * or reaches a terminal state.
 */

import "server-only";

import { prismaUnguarded } from "@/lib/db";
import { RESEARCH_WORKING_STATES } from "@/lib/research/domain";
import { researchEngine } from "@/lib/research/run";

/*
 * THE FLOOR, not the cadence.
 *
 * This worker is a restart-safety net: the API nudges an accepted run the
 * moment it is created (see the note above), so this loop exists for the runs
 * a process death would otherwise strand. It does not have to ask every five
 * seconds forever — and asking anyway is not free when the database is in
 * another datacentre.
 *
 * Production `pg_stat_statements` for this deployment: 6.3 MILLION queries at
 * a mean execution time of 0.342ms, for an account base of two. The research
 * poll alone accounted for roughly 750,000 of them. Each one is ~0.06ms of
 * database work wrapped in a ~20ms round trip from the VM, on a box that is
 * also running the web server the reader is waiting on.
 *
 * So: five seconds while there is work, doubling up to a minute once there is
 * none, and back to five the instant a run appears. An idle deployment goes
 * from 17,280 polls a day to about 1,400.
 */
const TICK_MS = 5_000;
const IDLE_TICK_MAX_MS = 60_000;
const MAX_RUNS_PER_TICK = 8;
const WORKER_ID = `research-worker:${process.pid}:${process.env.HOSTNAME ?? "local"}`;

let stopping = false;
const activeRuns = new Set<string>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Returns how many runs this tick claimed, so the loop can decide to wait. */
async function tick(): Promise<number> {
  const now = new Date();
  const candidates = await prismaUnguarded.researchRun.findMany({
    where: {
      state: { in: ["accepted", ...RESEARCH_WORKING_STATES] },
      OR: [{ workerLeaseUntil: null }, { workerLeaseUntil: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
    take: MAX_RUNS_PER_TICK,
    select: { id: true, userId: true },
  });

  await Promise.all(
    candidates
      .filter((run) => !activeRuns.has(run.id))
      .map(async (run) => {
        activeRuns.add(run.id);
        try {
          await researchEngine().drive({
            runId: run.id,
            userId: run.userId,
            workerId: WORKER_ID,
          });
        } catch (error) {
          // The engine records stage failures. A worker-level exception should
          // not stop the sweep from adopting the remaining runs.
          console.error("[research-worker] drive failed", { runId: run.id, error });
        } finally {
          activeRuns.delete(run.id);
        }
      })
  );

  return candidates.length;
}

async function main(): Promise<void> {
  process.once("SIGTERM", () => {
    stopping = true;
  });
  process.once("SIGINT", () => {
    stopping = true;
  });
  console.info("[research-worker] started", { workerId: WORKER_ID });

  let waitMs = TICK_MS;
  while (!stopping) {
    try {
      const claimed = await tick();
      // Work resets the cadence immediately, so a busy deployment polls
      // exactly as often as it did before. An idle one doubles its way out.
      waitMs = claimed > 0 ? TICK_MS : Math.min(waitMs * 2, IDLE_TICK_MAX_MS);
    } catch (error) {
      // A failing tick is not an idle one: keep the floor rather than backing
      // off, or a database blip would quietly stretch recovery to a minute.
      console.error("[research-worker] tick failed", { error });
      waitMs = TICK_MS;
    }
    if (!stopping) await delay(waitMs);
  }

  await prismaUnguarded.$disconnect();
  console.info("[research-worker] stopped", { workerId: WORKER_ID });
}

void main().catch((error: unknown) => {
  console.error("[research-worker] fatal", { error });
  process.exitCode = 1;
});

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

const TICK_MS = 5_000;
const MAX_RUNS_PER_TICK = 8;
const WORKER_ID = `research-worker:${process.pid}:${process.env.HOSTNAME ?? "local"}`;

let stopping = false;
const activeRuns = new Set<string>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tick(): Promise<void> {
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
}

async function main(): Promise<void> {
  process.once("SIGTERM", () => {
    stopping = true;
  });
  process.once("SIGINT", () => {
    stopping = true;
  });
  console.info("[research-worker] started", { workerId: WORKER_ID });

  while (!stopping) {
    try {
      await tick();
    } catch (error) {
      console.error("[research-worker] tick failed", { error });
    }
    if (!stopping) await delay(TICK_MS);
  }

  await prismaUnguarded.$disconnect();
  console.info("[research-worker] stopped", { workerId: WORKER_ID });
}

void main().catch((error: unknown) => {
  console.error("[research-worker] fatal", { error });
  process.exitCode = 1;
});

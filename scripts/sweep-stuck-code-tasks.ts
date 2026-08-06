/**
 * Moves Juno Code tasks whose runner died out of `running`.
 *
 * A cloud run posts its own terminal status. When the runner is hard-killed
 * first — OOM, cancellation, the job's time ceiling, the VM reclaimed — that
 * post never happens and the task stays `running` forever: a spinner in the
 * UI, and a row invisible to every "what failed" query.
 *
 * Run it on a schedule (every 10–15 minutes is ample; the windows are in tens
 * of minutes).
 *
 *   npm run tasks:sweep            # apply
 *   npm run tasks:sweep -- --dry   # report what would change, write nothing
 *
 * This worker intentionally has a database-only import graph, so it can run
 * under plain Node without Next's React server condition.
 */
import { prismaUnguarded } from "@/lib/db";
import { appendTaskEvents } from "@/lib/code-task-events";
import { selectStuckTasks, sweepCutoff, SWEEPABLE_STATUSES } from "@/lib/stuck-task-sweeper";

const DRY = process.argv.includes("--dry") || process.argv.includes("--dry-run");
const DAEMON = process.argv.includes("--daemon");
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
let stopping = false;

export async function sweepOnce(): Promise<void> {
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
  console.log(
    `[sweep] ${candidates.length} silent task(s) examined, ${stuck.length} presumed dead` +
      (DRY ? " — DRY RUN, nothing will be written" : "")
  );

  let swept = 0;
  let failed = 0;
  for (const { task, verdict } of stuck) {
    console.log(`[sweep] ${task.id} (${task.status}, ${task.target}) → failed: ${verdict.reason}`);
    if (DRY) continue;
    try {
      // Through `appendTaskEvents` rather than a bare status update, so the
      // reason lands in the transcript the user is actually looking at — and
      // so `fromStatus` makes the transition conditional: a runner that comes
      // back to life in the same instant and posts its own terminal status
      // wins, rather than being overwritten by this.
      await appendTaskEvents(
        task.id,
        [
          {
            kind: "error",
            payload: { message: verdict.message ?? "The runner stopped reporting." },
            key: `sweeper:${task.id}:${verdict.reason}`,
          },
        ],
        { status: "failed", fromStatus: task.status }
      );
      swept += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `[sweep] ${task.id} could not be reconciled: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  console.log(`\n[sweep] done — ${swept} reconciled, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  // The daemon mode is used by PM2 in production. Keeping the loop in one
  // process avoids cron races and makes a temporary database outage visible in
  // logs without creating overlapping sweepers.
  do {
    try {
      await sweepOnce();
    } catch (err) {
      console.error("[sweep] run failed", err);
      if (!DAEMON) {
        process.exitCode = 1;
        break;
      }
    }
    if (DAEMON && !stopping) {
      await new Promise((resolve) => setTimeout(resolve, SWEEP_INTERVAL_MS));
    }
  } while (DAEMON && !stopping);

  await prismaUnguarded.$disconnect();
}

process.once("SIGTERM", () => {
  stopping = true;
});
process.once("SIGINT", () => {
  stopping = true;
});

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  return prismaUnguarded.$disconnect();
});

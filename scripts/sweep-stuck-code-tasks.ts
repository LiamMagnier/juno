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
 * Requires NODE_OPTIONS=--conditions=react-server (set by the npm script).
 */
import { prismaUnguarded } from "@/lib/db";
import { appendTaskEvents } from "@/lib/code-remote";
import { selectStuckTasks, sweepCutoff, SWEEPABLE_STATUSES } from "@/lib/stuck-task-sweeper";

const DRY = process.argv.includes("--dry") || process.argv.includes("--dry-run");

async function main(): Promise<void> {
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

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prismaUnguarded.$disconnect());

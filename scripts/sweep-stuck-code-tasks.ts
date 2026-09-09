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
import { sweepStuckCodeTasks } from "@/lib/sweep-stuck-code-tasks";

const DRY = process.argv.includes("--dry") || process.argv.includes("--dry-run");
const DAEMON = process.argv.includes("--daemon");
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
let stopping = false;

async function sweepOnce(): Promise<void> {
  const result = await sweepStuckCodeTasks({ dry: DRY, log: (line) => console.log(line) });
  console.log(`\n[sweep] done — ${result.reconciled} reconciled, ${result.failed} failed`);
  if (result.failed > 0) process.exitCode = 1;
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
});

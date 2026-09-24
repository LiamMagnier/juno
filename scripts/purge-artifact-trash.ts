/**
 * Empties Recently deleted: removes artifacts that have been trashed for 30
 * days or more, with every version and public link, across all accounts.
 *
 *   npm run artifacts:purge                  # one pass
 *   npm run artifacts:purge -- --dry         # report what would go, write nothing
 *   npm run artifacts:purge -- --days 45     # a longer window (never under 7)
 *   npm run artifacts:purge -- --daemon      # PM2: a pass every 6 hours
 *
 * DRY UNLESS ARMED. Without `JUNO_ARTIFACTS_PURGE=1` every pass is a dry run,
 * whatever the flags say: the job logs how many rows are eligible and deletes
 * none. It stays unarmed until the deletion ledger lands (04-MERGE-PLAN §3.4,
 * §13.5); src/lib/artifact-trash.ts enforces the same gate for any caller.
 *
 * Every line starts `[artifact-purge] eligible=… purged=…`, so the log answers
 * "is anything waiting, and did anything go" at a glance. The exit checklist
 * for R1 is a dry-run line reading eligible=0.
 *
 * Six hours because nothing here is urgent: a row eligible at 09:00 and purged
 * at 15:00 has been in the trash for 30 days and a quarter. It is a PM2 loop
 * rather than a crontab line for the same reasons as `juno-code-sweeper`: one
 * process, no overlapping runs, and a database outage shows up in its log.
 */
import { artifactPurgeArmed } from "@/lib/artifact-flags";
import { MIN_TRASH_RETENTION_DAYS, TRASH_RETENTION_DAYS, purgeExpiredArtifacts } from "@/lib/artifact-trash";
import { prismaUnguarded } from "@/lib/db";

const DRY = process.argv.includes("--dry") || process.argv.includes("--dry-run");
const DAEMON = process.argv.includes("--daemon");
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;
let stopping = false;
let wake: (() => void) | null = null;

function retentionDays(): number {
  const flagIndex = process.argv.indexOf("--days");
  if (flagIndex === -1) return TRASH_RETENTION_DAYS;
  const raw = process.argv[flagIndex + 1];
  const days = Number(raw);
  if (!Number.isSafeInteger(days) || days < MIN_TRASH_RETENTION_DAYS) {
    throw new Error(`--days must be a whole number of days, at least ${MIN_TRASH_RETENTION_DAYS} (got "${raw}").`);
  }
  return days;
}

async function purgeOnce(days: number): Promise<void> {
  const report = await purgeExpiredArtifacts({ days, dryRun: DRY });
  const why = !report.dryRun ? "" : DRY ? " dry=--dry" : " dry=unarmed (JUNO_ARTIFACTS_PURGE is not 1)";
  console.log(
    `[artifact-purge] eligible=${report.eligible} purged=${report.purged} days=${days} cutoff=${report.cutoff.toISOString()}${why}`,
  );
}

async function main(): Promise<void> {
  // Parsed once, before the loop: a bad flag is a startup failure PM2 shows,
  // not an error logged every six hours by a daemon that never does anything.
  const days = retentionDays();
  if (DAEMON) {
    console.log(`[artifact-purge] daemon started; every ${PURGE_INTERVAL_MS / 3_600_000}h, ${artifactPurgeArmed() ? "ARMED" : "dry (unarmed)"}`);
  }
  do {
    try {
      await purgeOnce(days);
    } catch (err) {
      console.error("[artifact-purge] run failed", err instanceof Error ? err.message : String(err));
      if (!DAEMON) {
        process.exitCode = 1;
        break;
      }
    }
    if (DAEMON && !stopping) {
      // Interruptible, so PM2's stop does not wait out six hours.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, PURGE_INTERVAL_MS);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
    }
  } while (DAEMON && !stopping);

  await prismaUnguarded.$disconnect();
}

function stop(): void {
  stopping = true;
  wake?.();
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

main().catch(async (err) => {
  console.error("[artifact-purge]", err instanceof Error ? err.message : String(err));
  await prismaUnguarded.$disconnect().catch(() => undefined);
  process.exitCode = 1;
});

/**
 * The artifact lifecycle's two scheduled jobs, in one PM2 loop
 * (`juno-artifact-maintenance`, deploy/ecosystem.config.js):
 *
 *   - SEAL IDLE DRAFTS, every minute. A design draft untouched for
 *     ARTIFACT_DRAFT_IDLE_MS becomes the next immutable version
 *     (src/lib/artifact-writes.ts), so an edit run that simply stopped — the
 *     tab closed without the page's own seal reaching the server — still ends
 *     as a version the apps sync and a publication can serve.
 *   - PURGE THE TRASH, every six hours: artifacts in Recently deleted longer
 *     than ARTIFACT_TRASH_RETENTION_DAYS go for good, with every version and
 *     link (src/lib/artifact-trash.ts). DRY UNLESS ARMED: without
 *     `JUNO_ARTIFACTS_PURGE=1` every purge pass only logs how many rows are
 *     eligible.
 *
 *   npm run artifacts:maintenance                   # one pass of each
 *   npm run artifacts:maintenance -- --dry          # purge reports only
 *   npm run artifacts:maintenance -- --days 45      # a longer trash window (never under 7)
 *   npm run artifacts:maintenance -- --daemon       # PM2
 *
 * Log lines start `[artifact-drafts]` and `[artifact-purge] eligible=… purged=…`.
 */
import { artifactPurgeArmed } from "@/lib/artifact-flags";
import { ARTIFACT_TRASH_RETENTION_DAYS, MIN_TRASH_RETENTION_DAYS, purgeExpiredArtifacts } from "@/lib/artifact-trash";
import { sealIdleDrafts } from "@/lib/artifact-writes";
import { prismaUnguarded } from "@/lib/db";

const DRY = process.argv.includes("--dry") || process.argv.includes("--dry-run");
const DAEMON = process.argv.includes("--daemon");
const TICK_MS = 60 * 1000;
const PURGE_EVERY_TICKS = 6 * 60;
let stopping = false;
let wake: (() => void) | null = null;

function retentionDays(): number {
  const flagIndex = process.argv.indexOf("--days");
  if (flagIndex === -1) return ARTIFACT_TRASH_RETENTION_DAYS;
  const raw = process.argv[flagIndex + 1];
  const days = Number(raw);
  if (!Number.isSafeInteger(days) || days < MIN_TRASH_RETENTION_DAYS) {
    throw new Error(`--days must be a whole number of days, at least ${MIN_TRASH_RETENTION_DAYS} (got "${raw}").`);
  }
  return days;
}

async function sealOnce(): Promise<void> {
  const sealed = await sealIdleDrafts();
  if (sealed > 0 || !DAEMON) console.log(`[artifact-drafts] sealed=${sealed}`);
}

async function purgeOnce(days: number): Promise<void> {
  const report = await purgeExpiredArtifacts({ days, dryRun: DRY });
  const why = !report.dryRun ? "" : DRY ? " dry=--dry" : " dry=unarmed (JUNO_ARTIFACTS_PURGE is not 1)";
  console.log(
    `[artifact-purge] eligible=${report.eligible} purged=${report.purged} days=${days} cutoff=${report.cutoff.toISOString()}${why}`,
  );
}

async function main(): Promise<void> {
  // Parsed once: a bad flag is a startup failure PM2 shows, not an error
  // logged every six hours by a daemon that never does anything.
  const days = retentionDays();
  if (DAEMON) {
    console.log(`[artifact-maintenance] daemon started; drafts every 1m, purge every 6h, ${artifactPurgeArmed() ? "ARMED" : "purge dry (unarmed)"}`);
  }
  let tick = 0;
  do {
    try {
      await sealOnce();
    } catch (err) {
      console.error("[artifact-drafts] run failed", err instanceof Error ? err.message : String(err));
      if (!DAEMON) process.exitCode = 1;
    }
    if (tick % PURGE_EVERY_TICKS === 0) {
      try {
        await purgeOnce(days);
      } catch (err) {
        console.error("[artifact-purge] run failed", err instanceof Error ? err.message : String(err));
        if (!DAEMON) process.exitCode = 1;
      }
    }
    tick++;
    // Give the connection back between passes. Production's pooler runs in
    // session mode with 15 clients for every process on the VM, and a daemon
    // that wakes once a minute must not hold one of them while it sleeps.
    if (DAEMON) await prismaUnguarded.$disconnect().catch(() => undefined);
    if (DAEMON && !stopping) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, TICK_MS);
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
  console.error("[artifact-maintenance]", err instanceof Error ? err.message : String(err));
  await prismaUnguarded.$disconnect().catch(() => undefined);
  process.exitCode = 1;
});

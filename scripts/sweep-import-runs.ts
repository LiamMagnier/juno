import {
  IMPORT_RECOVERY_INTERVAL_MS,
  sweepExpiredImportRuns,
  sweepQueuedImportIngests,
} from "../src/lib/import-recovery";
import { prismaUnguarded } from "../src/lib/db";

let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const result = await sweepExpiredImportRuns();
    const ingests = await sweepQueuedImportIngests();
    if (result.runsRecovered > 0 || result.objectsFailed > 0 || ingests.claimed > 0 || ingests.failed > 0) {
      console.log(
        `[import-recovery] runs=${result.runsRecovered} deleted=${result.objectsDeleted} ` +
          `cleanupFailed=${result.objectsFailed} ingests=${ingests.recovered} ingestFailed=${ingests.failed}`,
      );
    }
  } catch (error) {
    console.error("[import-recovery] sweep failed", error instanceof Error ? error.message : String(error));
  } finally {
    running = false;
  }
}

async function main() {
  await tick();
  const timer = setInterval(tick, IMPORT_RECOVERY_INTERVAL_MS);

  async function shutdown() {
    clearInterval(timer);
    await prismaUnguarded.$disconnect();
    process.exit(0);
  }

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

void main().catch(async (error) => {
  console.error("[import-recovery] worker failed to start", error instanceof Error ? error.message : String(error));
  await prismaUnguarded.$disconnect().catch(() => undefined);
  process.exitCode = 1;
});

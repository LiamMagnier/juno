import { IMPORT_RECOVERY_INTERVAL_MS, sweepExpiredImportRuns } from "../src/lib/import-recovery";
import { prismaUnguarded } from "../src/lib/db";

let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const result = await sweepExpiredImportRuns();
    if (result.runsRecovered > 0 || result.objectsFailed > 0) {
      console.log(`[import-recovery] runs=${result.runsRecovered} deleted=${result.objectsDeleted} failed=${result.objectsFailed}`);
    }
  } catch (error) {
    console.error("[import-recovery] sweep failed", error instanceof Error ? error.message : String(error));
  } finally {
    running = false;
  }
}

async function shutdown() {
  clearInterval(timer);
  await prismaUnguarded.$disconnect();
  process.exit(0);
}

await tick();
const timer = setInterval(tick, IMPORT_RECOVERY_INTERVAL_MS);
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

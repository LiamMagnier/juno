/**
 * Scheduled-task worker — executes due ScheduledTasks and writes each result
 * into the task's conversation thread. Long-lived pm2 app ("juno-scheduler"):
 *
 *   npm run tasks:runner
 *
 * Every tick (60s) it claims tasks whose nextRunAt has passed (enabled only)
 * and runs them one at a time, capped per tick. Claiming bumps nextRunAt
 * atomically via updateMany, so a second worker — or an overlapping tick —
 * can never double-run a task; an in-process claimed set additionally guards
 * against re-entry while a run is still in flight. Requires
 * NODE_OPTIONS=--conditions=react-server (set by the npm script) so the
 * `server-only` guard in the llm import chain resolves to a no-op.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// —— Env loading (.env then .env.local; never override already-set keys) ——
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    const quoted = value.match(/^(["'])([\s\S]*)\1$/);
    if (quoted) value = quoted[2];
    else {
      const hash = value.indexOf(" #"); // inline comment on unquoted values
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile(join(ROOT, ".env"));
loadEnvFile(join(ROOT, ".env.local"));

const TICK_MS = 60_000;
const MAX_RUNS_PER_TICK = 20;

async function main() {
  // Env must be in place before the lib chain loads — import inside main.
  const { prisma } = await import("../src/lib/prisma");
  const { computeNextRunAt, executeTask } = await import("../src/lib/scheduled-tasks");

  // Task ids with a run currently in flight in THIS process.
  const claimed = new Set<string>();

  const tick = async () => {
    const now = new Date();
    const due = await prisma.scheduledTask.findMany({
      where: { enabled: true, nextRunAt: { lte: now } },
      orderBy: { nextRunAt: "asc" },
      take: MAX_RUNS_PER_TICK,
    });
    for (const task of due) {
      if (claimed.has(task.id)) continue;
      // Atomic claim: only the updateMany that still matches the due filter
      // wins, and bumping nextRunAt takes the task off every other worker's
      // due list for the duration of the run.
      const claim = await prisma.scheduledTask.updateMany({
        where: { id: task.id, enabled: true, nextRunAt: { lte: now } },
        data: { nextRunAt: computeNextRunAt(task, new Date()) },
      });
      if (claim.count === 0) continue; // another worker got there first
      claimed.add(task.id);
      try {
        const outcome = await executeTask(task.id);
        console.info(`[scheduler] ran "${task.name}"`, {
          taskId: task.id,
          status: outcome.status,
          ...(outcome.costMicroUsd != null ? { costMicroUsd: outcome.costMicroUsd } : {}),
          ...(outcome.error ? { error: outcome.error } : {}),
        });
      } catch (err) {
        console.error(`[scheduler] run crashed for "${task.name}"`, {
          taskId: task.id,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        claimed.delete(task.id);
      }
    }
  };

  console.info(`[scheduler] worker started — tick every ${TICK_MS / 1000}s, max ${MAX_RUNS_PER_TICK} runs/tick`);
  for (;;) {
    const started = Date.now();
    try {
      await tick();
    } catch (err) {
      // A failed tick (database blip…) is retried next tick — never fatal.
      console.error("[scheduler] tick failed", { message: err instanceof Error ? err.message : String(err) });
    }
    const elapsed = Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, Math.max(1_000, TICK_MS - elapsed)));
  }
}

main().catch((err) => {
  console.error("[scheduler] fatal", err);
  process.exit(1);
});

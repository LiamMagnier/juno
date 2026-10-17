import "server-only";
import { prisma } from "@/lib/prisma";
import {
  HEALTH_RUN_WINDOW,
  codeTaskAsHealthRun,
  scheduleHealth,
  type ClientScheduleHealth,
  type HealthRunRow,
  type HealthTriggerRow,
} from "@/lib/work/schedule-health";

/** How many routines' health is read at the same time. */
const HEALTH_READ_CONCURRENCY = 6;

/**
 * The health of each routine in a list (src/lib/work/schedule-health.ts),
 * read with one indexed query per routine (`WorkRun @@index([scheduleId,
 * createdAt])`, newest five) and the trigger rows the list already loaded.
 *
 * A Code routine's runs are Code sessions (`CodeTask`, same index), and only
 * the scheduler's records of fires that never ran (budget spent, Mac offline)
 * are `WorkRun` rows; both are read and merged newest first, so a nightly Code
 * routine that keeps failing says so, and one skipped for budget says that.
 * Never throws: a routine whose health cannot be read is listed without it.
 *
 * At most `HEALTH_READ_CONCURRENCY` routines are read at once: a list of a
 * hundred routines is up to two hundred small queries, and firing them all
 * together would queue every other request behind them on the pool.
 */
export async function loadScheduleHealth(
  userId: string,
  schedules: ReadonlyArray<{
    id: string;
    sessionId: string;
    enabled: boolean;
    runKind: string;
    triggers: readonly HealthTriggerRow[];
  }>,
  now = new Date()
): Promise<Map<string, ClientScheduleHealth>> {
  const out = new Map<string, ClientScheduleHealth>();
  await forEachBounded(schedules, HEALTH_READ_CONCURRENCY, async (schedule) => {
    try {
      const [workRuns, codeRuns] = await Promise.all([
        prisma.workRun.findMany({
          where: { userId, scheduleId: schedule.id },
          orderBy: { createdAt: "desc" },
          take: HEALTH_RUN_WINDOW,
          select: {
            id: true,
            status: true,
            terminalReason: true,
            terminalDetail: true,
            pauseReason: true,
            origin: true,
            createdAt: true,
            updatedAt: true,
            finishedAt: true,
            startedAt: true,
          },
        }),
        schedule.runKind === "code"
          ? prisma.codeTask.findMany({
              where: { userId, scheduleId: schedule.id },
              orderBy: { createdAt: "desc" },
              take: HEALTH_RUN_WINDOW,
              select: {
                id: true,
                status: true,
                conversationId: true,
                runnerClaimedAt: true,
                createdAt: true,
                updatedAt: true,
              },
            })
          : Promise.resolve([]),
      ]);
      const runs: HealthRunRow[] = [...workRuns, ...codeRuns.map(codeTaskAsHealthRun)]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, HEALTH_RUN_WINDOW);
      out.set(
        schedule.id,
        scheduleHealth({
          scheduleId: schedule.id,
          sessionId: schedule.sessionId,
          enabled: schedule.enabled,
          triggers: schedule.triggers,
          runs,
          now,
        })
      );
    } catch (error) {
      console.error("[work] routine health unavailable", {
        scheduleId: schedule.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return out;
}

/** Runs `work` over `items`, at most `limit` at a time. */
async function forEachBounded<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await work(item);
    }
  });
  await Promise.all(lanes);
}

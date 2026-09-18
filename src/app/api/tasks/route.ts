import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { serializeTask, LATEST_RUN_INCLUDE } from "@/lib/scheduled-tasks";

export const runtime = "nodejs";

/*
 * The scheduled-task surface, retired.
 *
 * Juno had two answers to "run this for me later": `ScheduledTask` (a prompt, a
 * cadence, a plan-shaped limit on how many you could keep, and a PM2 worker of
 * its own) and `WorkSchedule` (triggers, timezones with real daylight-saving
 * arithmetic, missed-run policies, budgets, and a dispatcher that leases). The
 * second does everything the first did and the first did it worse, so it is
 * gone: **Automations is the one surface**.
 *
 * WHAT HAPPENED TO THE ROWS. `scripts/work-scheduler.ts` adopts every
 * `ScheduledTask` into a `WorkSchedule` that fires at the same wall-clock time,
 * in the same zone, with the fire it was owed copied across rather than
 * recomputed — and switches the legacy row off in the same transaction, so the
 * fire belongs to exactly one dispatcher. Every cadence the enum can hold maps
 * (`planTaskMigration`), and `tests/work-schedule.test.ts` walks the whole enum
 * to prove it, because a schedule that silently stops running is the worst
 * possible outcome of a migration.
 *
 * WHAT THIS ROUTE STILL DOES. GET, so the rows stay readable from a client that
 * has not been updated, and so a person can see where their task went. POST is
 * gone: a creation surface that is being retired must not keep taking new rows,
 * or the migration never finishes. PATCH and DELETE live on `[id]`, and refuse
 * once a task has been adopted — the routine is the live thing by then, and
 * editing the shell would change nothing while looking like it had.
 *
 * WHAT WENT WITH IT. `taskLimitForPlan` — FREE 0, PRO 3, MAX 10 — was the only
 * cap on how many things an account could have running for it on a clock, and
 * `WorkSchedule` has never had one. Retiring the route retires the cap: what a
 * person may spend is the account's usage window, not an arbitrary count of
 * automations.
 */

/** Kept so a stale client's list is not an empty screen. See the note above. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tasks = await prisma.scheduledTask.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    include: LATEST_RUN_INCLUDE,
  });

  // Which routine each task became, so a client can send somebody to it rather
  // than showing a row that looks paused for no reason. One query for the page
  // rather than one per row.
  const adopted = await prisma.workSchedule.findMany({
    where: { userId: user.id, legacyScheduledTaskId: { in: tasks.map((task) => task.id) } },
    select: { id: true, legacyScheduledTaskId: true },
  });
  const byTask = new Map(adopted.map((row) => [row.legacyScheduledTaskId, row.id]));

  return NextResponse.json({
    tasks: tasks.map((task) => ({
      ...serializeTask(task),
      // Null until the sweep has been round. A client that does not know this
      // key is unaffected, which is the whole reason it is an addition.
      movedToScheduleId: byTask.get(task.id) ?? null,
    })),
    // Zero, and it no longer means a plan. It means this surface creates
    // nothing — which is what the native clients render it as, a disabled
    // "new task" button, and that is the correct control for a retired
    // creation surface. The sentence they show beside it is dated; a number
    // that re-enabled a button whose POST answers 410 would be worse.
    limit: 0,
  });
}

export async function POST() {
  return NextResponse.json(
    {
      error: "moved_to_automations",
      message:
        "Scheduled tasks are now Automations, which do everything these did and more — event triggers, real timezones and a proper catch-up policy. Your existing tasks have already moved. Create new ones at /automations.",
    },
    { status: 410 }
  );
}

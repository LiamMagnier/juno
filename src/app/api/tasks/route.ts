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
 * HOW THE NATIVE CLIENTS ARE TOLD. The web surface is gone (`/tasks` redirects)
 * but the macOS and iOS Tasks screens still call this route, so the retirement
 * has to be something they can READ rather than something they infer. Two keys
 * carry it, and both of them are flags rather than counts:
 *
 *   `creatable: false` disables the "new task" control. It replaced an earlier
 *   attempt to say the same thing with `limit: 0`, which did not work:
 *   `NativeScheduledTaskStore.isPlanLocked` was `limit == 0 && tasks.isEmpty`,
 *   and every account this retirement is about has at least one task — so the
 *   flag was false exactly where it mattered, the button stayed enabled, and
 *   pressing it POSTed to a route that answers 410.
 *
 *   `movedToScheduleId`, per row, disables that row's pause toggle, Edit and
 *   Delete. Those all go to `/api/tasks/[id]`, which answers 409 for an adopted
 *   task — and the sweep adopts every task and switches it off, so without this
 *   the list would show every task paused with no working control to unpause
 *   it. A card whose switch cannot switch is worse than no card.
 *
 * `limit` is still emitted, still zero, and now means nothing but "no plan cap
 * applies". It stays only so an OLD client — one that has not learned the two
 * keys above — keeps decoding the payload at all.
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
      // Null until the sweep has been round. Once it is set, this row's
      // toggle, Edit and Delete are refused with 409 — so the clients disable
      // them on this key rather than letting a person press a control that
      // cannot work.
      movedToScheduleId: byTask.get(task.id) ?? null,
    })),
    // The retirement, stated rather than inferred. See the note above for why
    // `limit: 0` could not carry it.
    creatable: false,
    readOnly: true,
    // Zero, and it no longer means a plan. Kept only so a client that predates
    // the two flags above still decodes this payload.
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

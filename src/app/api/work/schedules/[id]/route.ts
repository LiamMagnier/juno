import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import {
  WORK_LIVE_STATUSES,
} from "@/lib/work/domain";
import { finishRun } from "@/lib/work/store";
import {
  isTimeTriggerKind,
  isValidTimeZone,
  nextFireForTriggers,
  parseScheduleRunConfig,
  patchScheduleSchema,
  planScheduleEdit,
  scheduleTargetOf,
  serializeSchedule,
} from "@/lib/work/schedule";
import { normalizeTriggerDrafts, sameTriggerSet, type TriggerDraft } from "@/lib/work/triggers";
import { admissionRefusal } from "@/app/api/work/protocol";

export const runtime = "nodejs";


/**
 * The stored run configuration as a plain object, for merging a patch into.
 *
 * Not `parseScheduleRunConfig`, deliberately: that reader keeps only the keys
 * this build understands, which is right for acting on the column and wrong for
 * rewriting it, because writing back what it returned would erase everything
 * else that was in there.
 */
function storedRunConfig(value: Prisma.JsonValue): Prisma.JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

/**
 * Live statuses a run only reaches once an executor has taken it.
 *
 * Derived from the live set rather than listed, so a status added to `domain.ts`
 * lands on the "already being executed" side by default — which is the safe
 * direction here, because the mistake in the other direction is telling a user
 * that work was stopped when it was not. `draft` is excluded because no run is
 * ever in it; sessions are.
 */
const CLAIMED_STATUSES = WORK_LIVE_STATUSES.filter(
  (status) => status !== "queued" && status !== "draft"
);

/**
 * The triggers that decide WHEN a schedule fires, out of the set that decides
 * whether it fires at all.
 *
 * Used to compare two trigger sets for the one question `nextRunAt` depends on.
 * The event kinds are dropped because they contribute no fire — `nextFireAfter`
 * has nothing to compute for an email arriving — so a change to one of them
 * cannot move a fire and must not be allowed to.
 */
function firingTriggers<T extends { kind: string }>(triggers: readonly T[]): T[] {
  return triggers.filter((trigger) => isTimeTriggerKind(trigger.kind));
}

interface RunsAfterStopping {
  /** Fires that had not started and now never will. */
  cancelled: number;
  /** Runs an executor is already driving, which nothing here can stop. */
  stillRunning: number;
}

/**
 * Cancels the fires this schedule has queued, and counts the ones it cannot.
 *
 * The two halves are genuinely different things and collapsing them would be a
 * lie told to the person switching the schedule off. `claimRun` only ever takes
 * a run whose status is `queued`, so moving those to `cancelled` really does
 * stop them: no executor will ever pick one up.
 *
 * Past `queued` the run belongs to an executor and nothing on this side can
 * reach it. `finishRun` writes a terminal row and sends no message anywhere, and
 * the runner never asks whether the run it is driving was cancelled — it runs to
 * the end, spends the budget and sends whatever it was going to send, and only
 * then finds its own `finishRun` guarded out. So those runs are counted, not
 * cancelled: stamping them would put an authoritative "cancelled" on work that is
 * still happening, and would take the run out of every live list, which is the
 * one place the user could have seen it at all.
 *
 * A run claimed in the instant between the read and the write is cancelled all
 * the same — `finishRun` guards against terminal states, not against a claim —
 * which is the same outcome the run's own cancel button produces and is as far
 * as this can go without a second writer of terminal state.
 */
async function stopQueuedRuns(
  scheduleId: string,
  // The whole user rather than a bare id string, so each query below names the
  // session user at the point of the query, exactly as every other scoped
  // query in this tree does.
  // A helper taking `userId: string` is safe only if every call site passes the
  // session's id, which is a fact about the file rather than about the query —
  // and tests/work-security.test.ts is deliberately unwilling to take that on
  // trust, because the version of this helper that takes an id from a request
  // body looks identical at the point where it matters.
  user: { id: string },
  detail: string
): Promise<RunsAfterStopping> {
  const userId = user.id;
  const queued = await prisma.workRun.findMany({
    where: { scheduleId, userId: user.id, status: "queued" },
    select: { id: true },
  });

  let cancelled = 0;
  for (const run of queued) {
    const finished = await finishRun({ runId: run.id, userId, reason: "cancelled", detail });
    if (finished.finished) cancelled += 1;
  }

  const stillRunning = await prisma.workRun.count({
    where: { scheduleId, userId: user.id, status: { in: [...CLAIMED_STATUSES] } },
  });
  return { cancelled, stillRunning };
}

/**
 * What just happened to this schedule's runs, in the user's words.
 *
 * Written out rather than left for the client to infer from two numbers,
 * because the sentence that matters is the one about the runs that did NOT
 * stop, and a client that renders "paused" over a run still writing to the
 * user's Documents folder has told them the opposite of the truth.
 */
function stoppedExplanation(runs: RunsAfterStopping, gerund: string): string {
  const queued =
    runs.cancelled === 0
      ? "Nothing was waiting to start."
      : runs.cancelled === 1
        ? "One run that had not started yet was cancelled."
        : `${runs.cancelled} runs that had not started yet were cancelled.`;
  if (runs.stillRunning === 0) return queued;

  const subject = runs.stillRunning === 1 ? "One run is" : `${runs.stillRunning} runs are`;
  return `${queued} ${subject} already under way and will carry on to the end: ${gerund} a schedule stops it starting anything new, and does not stop work that has already begun. Stop ${runs.stillRunning === 1 ? "it" : "them"} from the run itself.`;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const schedule = await prisma.workSchedule.findFirst({
    where: { id, userId: user.id },
    include: { triggers: true },
  });
  if (!schedule) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ schedule: serializeSchedule(schedule, schedule.triggers) });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const parsed = patchScheduleSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const body = parsed.data;

  const existing = await prisma.workSchedule.findFirst({
    where: { id, userId: user.id },
    include: { triggers: true },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const timezone = body.timezone ?? existing.timezone;
  if (!isValidTimeZone(timezone)) {
    return NextResponse.json(
      { error: "invalid_timezone", message: `Unknown timezone "${timezone}".` },
      { status: 400 }
    );
  }

  const target = body.target ?? existing.target;
  // `hostId` is explicitly nullable in the patch, so `undefined` means "leave
  // it" and `null` means "clear it"; collapsing the two with `??` would make
  // clearing the host impossible to express.
  const hostId = body.hostId !== undefined ? body.hostId : existing.hostId;
  if (target === "local" && !hostId) {
    return NextResponse.json(
      { error: "host_required", message: "A local schedule has to say which Mac it runs on." },
      { status: 400 }
    );
  }
  // Only when the patch could change where this runs. A rename must not pay for
  // a host read, and re-running the admission check on every save would let a
  // schedule created before a Mac was revoked become un-editable — the user
  // could no longer even rename it to say why it is broken.
  if (
    body.target !== undefined ||
    body.hostId !== undefined ||
    body.requiredCapabilities !== undefined
  ) {
    const hosts = await prisma.workHost.findMany({ where: { userId: user.id } });
    const named = hostId ? hosts.find((host) => host.id === hostId) : undefined;
    // A host id in a request is a claim; the row that also carries this user's
    // id is what makes it true.
    if (hostId && !named) return NextResponse.json({ error: "Host not found" }, { status: 404 });

    const required =
      body.requiredCapabilities ?? parseScheduleRunConfig(existing.runConfig).requiredCapabilities;
    const refusal = admissionRefusal(scheduleTargetOf(target), named, required, hosts);
    if (refusal) return NextResponse.json(refusal, { status: 409 });
  }

  // The triggers are re-normalised against the EFFECTIVE timezone, not the
  // stored one, so a patch that moves a schedule to another zone validates the
  // trigger set the way the scheduler will read it afterwards.
  let drafts: TriggerDraft[] | null = null;
  if (body.triggers) {
    const normalized = normalizeTriggerDrafts(body.triggers, timezone);
    if (!normalized.ok) {
      return NextResponse.json(
        { error: "invalid_trigger", index: normalized.index, message: normalized.message },
        { status: 400 }
      );
    }
    drafts = normalized.drafts;
  } else if (body.timezone !== undefined && body.timezone !== existing.timezone) {
    // The zone moved but the triggers did not. They are re-validated anyway, so
    // the new fire below is computed from the same normalised form the
    // scheduler will read — and so a zone this build resolves but the trigger
    // set cannot be expressed in is refused rather than stored.
    const normalized = normalizeTriggerDrafts(existing.triggers, timezone);
    if (!normalized.ok) {
      return NextResponse.json(
        { error: "invalid_trigger", index: normalized.index, message: normalized.message },
        { status: 400 }
      );
    }
    drafts = normalized.drafts;
  }

  const enabledAfter = body.enabled ?? existing.enabled;
  // "Provided" is not "changed". Every form in this codebase re-sends the whole
  // object on save, so treating a submitted trigger list as a change would move
  // the schedule forward on a rename — which is exactly the legacy bug where an
  // overdue run is silently discarded by a PATCH that touched nothing about
  // when the schedule fires.
  const setChanged = drafts !== null && !sameTriggerSet(existing.triggers, drafts);
  // Narrower than `setChanged`, and deliberately so. `nextRunAt` comes from the
  // clock kinds alone — `nextFireForTriggers` skips every other kind — so
  // widening an email filter's sender list changes what starts a run, not when
  // the next one is due. Comparing the whole set here would move the fire for
  // that edit too, and a schedule that runs daily at 09:00 as well as on email
  // would lose its overdue morning run every time the filter was touched.
  const firingChanged =
    drafts !== null && !sameTriggerSet(firingTriggers(existing.triggers), firingTriggers(drafts));
  const zoneChanged = body.timezone !== undefined && body.timezone !== existing.timezone;

  const now = new Date();
  const edit = planScheduleEdit({
    now,
    currentNextRunAt: existing.nextRunAt,
    firingChanged: firingChanged || zoneChanged,
    enabledBefore: existing.enabled,
    enabledAfter,
    recomputed: nextFireForTriggers(drafts ?? existing.triggers, timezone, now),
  });

  const schedule = await prisma.$transaction(async (tx) => {
    // The full set, not the firing subset: an edit that only touches an email
    // filter still has to be written down. Never merely because the zone
    // changed, though — the zone lives on the schedule, not on these rows, and
    // re-creating them would throw away every trigger's `lastEventKey` and
    // `lastFiredAt`, so moving a schedule from Paris to Berlin would silently
    // re-fire it on the email it has already run for.
    if (setChanged) {
      // Replaced rather than merged. A trigger has no client-stable identity —
      // the submitted list is the whole set — and matching old rows to new ones
      // by position would silently carry one trigger's `lastEventKey` onto a
      // different filter, which is how a brand-new trigger arrives already
      // deduplicated against somebody else's email.
      await tx.workTrigger.deleteMany({ where: { scheduleId: id, userId: user.id } });
      await tx.workTrigger.createMany({
        data: (drafts ?? []).map((draft) => ({
          scheduleId: id,
          userId: user.id,
          kind: draft.kind,
          config: draft.config,
          enabled: draft.enabled,
          dedupeWindowSec: draft.dedupeWindowSec,
        })),
      });
    }

    await tx.workSchedule.update({
      where: { id, userId: user.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.instructions !== undefined
          ? // Versioned rather than overwritten in place, so a run that is
            // already going is still attributable to the text it was given.
            { instructions: body.instructions, instructionsVersion: { increment: 1 } }
          : {}),
        ...(body.target !== undefined ? { target: body.target } : {}),
        ...(body.hostId !== undefined ? { hostId: body.hostId } : {}),
        ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
        ...(body.budget
          ? {
              maxCostMicroUsd: body.budget.maxCostMicroUsd,
              maxTokens: body.budget.maxTokens,
              maxRuntimeMs: body.budget.maxRuntimeMs,
            }
          : {}),
        ...(body.unattendedPolicy !== undefined ? { unattendedPolicy: body.unattendedPolicy } : {}),
        ...(body.hostOfflinePolicy !== undefined
          ? { hostOfflinePolicy: body.hostOfflinePolicy }
          : {}),
        ...(body.missedRunPolicy !== undefined ? { missedRunPolicy: body.missedRunPolicy } : {}),
        ...(body.notifyPolicy !== undefined ? { notifyPolicy: body.notifyPolicy } : {}),
        ...(body.maxConcurrentRuns !== undefined
          ? { maxConcurrentRuns: body.maxConcurrentRuns }
          : {}),
        ...(body.model !== undefined || body.requiredCapabilities !== undefined
          ? {
              // Merged over what is there rather than replacing it. A key a
              // newer deployment put in this column belongs to the deployment
              // that knows what it means, and rewriting the object from the two
              // fields this build happens to edit would delete it — silently,
              // on a request that only meant to change the model.
              runConfig: {
                ...storedRunConfig(existing.runConfig),
                ...(body.model !== undefined ? { model: body.model } : {}),
                ...(body.requiredCapabilities !== undefined
                  ? { requiredCapabilities: body.requiredCapabilities }
                  : {}),
              },
              runConfigVersion: { increment: 1 },
            }
          : {}),
        ...(edit.write ? { nextRunAt: edit.nextRunAt } : {}),
      },
    });

    return tx.workSchedule.findFirstOrThrow({
      where: { id, userId: user.id },
      include: { triggers: true },
    });
  });

  // After the write, so a schedule the user has just paused is already paused
  // when its queued fires are cancelled: doing it first leaves a window in which
  // the dispatcher sees an enabled schedule with nothing queued and starts
  // another.
  const stopped =
    existing.enabled && !enabledAfter
      ? await stopQueuedRuns(id, user, "The schedule was paused.")
      : null;

  return NextResponse.json({
    schedule: serializeSchedule(schedule, schedule.triggers),
    // The client renders "runs again tomorrow at 09:00" from `nextRunAt`; this
    // says in words why that did or did not move, which is the difference
    // between a pause that looks like it lost a run and one that plainly did not.
    scheduling: edit.explanation,
    ...(stopped ? { runs: { ...stopped, explanation: stoppedExplanation(stopped, "Pausing") } } : {}),
  });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const schedule = await prisma.workSchedule.findFirst({
    where: { id, userId: user.id },
    select: { id: true },
  });
  if (!schedule) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Stop the fires that have not started before the row disappears, so a Mac
  // cannot pick one up seconds after the schedule that produced it is gone.
  const stopped = await stopQueuedRuns(id, user, "The schedule was deleted.");

  // A hard delete, unlike a session's — `WorkSchedule` has no `deletedAt` to
  // soft-delete into. The triggers go with it by cascade, and
  // `WorkRun.scheduleId` is `SetNull`, so the runs it started survive in the
  // session's own history. That is also why a run still under way is not orphaned
  // by this: it stays on its session, visible and stoppable, which is what makes
  // it honest to leave it running rather than stamp it cancelled here.
  await prisma.workSchedule.deleteMany({ where: { id, userId: user.id } });

  return NextResponse.json({
    ok: true,
    runs: { ...stopped, explanation: stoppedExplanation(stopped, "Deleting") },
  });
}

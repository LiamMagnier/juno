import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import {
  describeCapability,
  selectTarget,
  type WorkCapability,
  type WorkTarget,
} from "@/lib/work/domain";
import {
  createScheduleSchema,
  hostCapabilityView,
  isValidTimeZone,
  nextFireForTriggers,
  parseScheduleListQuery,
  serializeSchedule,
  type WorkHostRow,
} from "@/lib/work/schedule";
import { normalizeTriggerDrafts } from "@/lib/work/triggers";
import { createWorkSession } from "@/lib/work/store";
import { refusalForSelection, type RunRefusal } from "@/app/api/work/protocol";

export const runtime = "nodejs";

/** Matches the constant the run-dispatch route and the scheduler each hold, for
 *  the same reason: turning cloud off should produce an honest refusal rather
 *  than schedules accepted for an executor that will never exist. */
const CLOUD_WORK_AVAILABLE = true;

/**
 * Whether a schedule with this target, host and capability list has anywhere to
 * run, and a sentence for the user when it does not.
 *
 * Every Mac is presented to `selectTarget` as `idle` — awake and free — rather
 * than at whatever its heartbeat currently says, and that is the substance of
 * this check. A nightly schedule is almost always created on a laptop that is
 * shut, so refusing it because the Mac is asleep at 23:00 would refuse the
 * ordinary case; `hostOfflinePolicy` is what answers "the Mac is away" at fire
 * time, and it can only answer it for a schedule that was allowed to exist.
 * What is worth refusing now is what will still be true tomorrow morning: a Mac
 * the user revoked, one switched off for Juno Work, or one that was never
 * granted a capability this schedule needs every time it fires. None of those
 * resolves overnight, and accepted here they become a `host_offline` marker run
 * every single morning that nobody is watching for.
 *
 * The decision is `selectTarget`'s — the same function the dispatcher will ask
 * at 07:00 — so a schedule that gets past here is one the dispatcher agrees has
 * somewhere to go. Only the sentence is replaced, and only when a specific Mac
 * was named: `selectTarget` describes an unusable host by its state, which comes
 * out as "MacBook is idle" for a machine whose real problem is a permission it
 * was never given.
 */
function admissionRefusal(
  target: WorkTarget,
  named: WorkHostRow | undefined,
  required: readonly WorkCapability[],
  hosts: readonly WorkHostRow[]
): RunRefusal | null {
  // The named Mac first, because `selectTarget` takes the first fully capable
  // host in the list. Ordered rather than filtered, so this asks exactly the
  // question the dispatcher will ask — it orders the same way, and an
  // `automatic` schedule really can end up on the second Mac.
  const ordered = named ? [named, ...hosts.filter((host) => host.id !== named.id)] : hosts;
  const refusal = refusalForSelection(
    selectTarget({
      requested: target,
      required,
      hosts: ordered.map((host) => hostCapabilityView(host, "idle")),
      cloudAvailable: CLOUD_WORK_AVAILABLE,
    })
  );
  if (!refusal || !named) return refusal;

  const why =
    named.revokedAt !== null
      ? `You revoked Juno's access to ${named.displayName}.`
      : !named.enabled
        ? `${named.displayName} is switched off for Juno Work.`
        : refusal.missing.length > 0
          ? `${named.displayName} has not been granted ${refusal.missing.map(describeCapability).join(", ")}.`
          : refusal.message;
  return { ...refusal, message: `${why} This schedule would fail every time it fired.` };
}

export async function GET(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const parsed = parseScheduleListQuery(new URL(req.url).searchParams);
  if (!parsed.ok) {
    return NextResponse.json({ error: "Invalid input", parameter: parsed.parameter }, { status: 400 });
  }
  const { enabled, sessionId, limit } = parsed.query;

  const schedules = await prisma.workSchedule.findMany({
    where: {
      userId: user.id,
      ...(enabled !== undefined ? { enabled } : {}),
      ...(sessionId ? { sessionId } : {}),
    },
    // Soonest fire first, and the schedules that will never fire again last:
    // Postgres sorts NULLs last on an ascending order, which is the order a
    // list of schedules wants without a second column to express it.
    orderBy: [{ nextRunAt: "asc" }, { createdAt: "desc" }],
    take: limit,
    include: { triggers: true },
  });

  return NextResponse.json({
    schedules: schedules.map((schedule) => serializeSchedule(schedule, schedule.triggers)),
  });
}

export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const parsed = createScheduleSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const body = parsed.data;

  if (!isValidTimeZone(body.timezone)) {
    return NextResponse.json(
      { error: "invalid_timezone", message: `Unknown timezone "${body.timezone}".` },
      { status: 400 }
    );
  }

  // A local schedule has to name its Mac. `selectTarget` would happily pick any
  // capable host, and that is right for a session a person is watching — but a
  // schedule that fires at 07:00 and silently moves to whichever laptop happens
  // to be awake is reaching into a machine the user did not choose for it.
  if (body.target === "local" && !body.hostId) {
    return NextResponse.json(
      { error: "host_required", message: "A local schedule has to say which Mac it runs on." },
      { status: 400 }
    );
  }

  const drafts = normalizeTriggerDrafts(body.triggers, body.timezone);
  if (!drafts.ok) {
    return NextResponse.json(
      { error: "invalid_trigger", index: drafts.index, message: drafts.message },
      { status: 400 }
    );
  }

  // Cross-entity ownership is re-checked rather than trusted from the body: a
  // host id or a session id in a request is a claim, and the only thing that
  // makes it true is a row that also carries this user's id.
  const hosts = await prisma.workHost.findMany({ where: { userId: user.id } });
  const named = body.hostId ? hosts.find((host) => host.id === body.hostId) : undefined;
  if (body.hostId && !named) return NextResponse.json({ error: "Host not found" }, { status: 404 });

  const refusal = admissionRefusal(body.target, named, body.requiredCapabilities ?? [], hosts);
  if (refusal) return NextResponse.json(refusal, { status: 409 });

  if (body.sessionId) {
    const session = await prisma.workSession.findFirst({
      where: { id: body.sessionId, userId: user.id, deletedAt: null },
      select: { id: true },
    });
    if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const sessionId =
    body.sessionId ??
    (
      await createWorkSession({
        userId: user.id,
        title: body.name,
        // "manual" because the user named the schedule themselves; leaving it
        // "default" would let an auto-titler rewrite a name they chose.
        titleSource: "manual",
        goal: body.instructions,
        requestedTarget: body.target,
        preferredHostId: body.hostId ?? null,
        requestedModel: body.model ?? null,
      })
    ).id;

  // Computed even when the schedule is created paused. The column is inert
  // while `enabled` is false — the dispatcher's due query filters on it — and
  // populated it lets a client show "next: tomorrow at 09:00" beside the pause,
  // which is the one thing a person wants to know before resuming.
  const nextRunAt = nextFireForTriggers(drafts.drafts, body.timezone, new Date());

  const schedule = await prisma.workSchedule.create({
    data: {
      userId: user.id,
      sessionId,
      name: body.name,
      enabled: body.enabled,
      instructions: body.instructions,
      target: body.target,
      hostId: body.hostId ?? null,
      timezone: body.timezone,
      runConfig: {
        model: body.model ?? null,
        requiredCapabilities: body.requiredCapabilities ?? [],
      },
      maxCostMicroUsd: body.budget?.maxCostMicroUsd ?? 0,
      maxTokens: body.budget?.maxTokens ?? 0,
      maxRuntimeMs: body.budget?.maxRuntimeMs ?? 0,
      // No client can ask for an unattended policy outside these three, and
      // there is no fourth to ask for: `WORK_UNATTENDED_POLICIES` contains no
      // member that grants anything, so a schedule cannot be created with one.
      unattendedPolicy: body.unattendedPolicy,
      hostOfflinePolicy: body.hostOfflinePolicy,
      missedRunPolicy: body.missedRunPolicy,
      notifyPolicy: body.notifyPolicy,
      maxConcurrentRuns: body.maxConcurrentRuns,
      nextRunAt,
      triggers: {
        create: drafts.drafts.map((draft) => ({
          userId: user.id,
          kind: draft.kind,
          config: draft.config,
          enabled: draft.enabled,
          dedupeWindowSec: draft.dedupeWindowSec,
        })),
      },
    },
    include: { triggers: true },
  });

  return NextResponse.json(
    { schedule: serializeSchedule(schedule, schedule.triggers) },
    { status: 201 }
  );
}

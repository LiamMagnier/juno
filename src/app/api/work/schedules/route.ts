import { NextResponse } from "next/server";
import type { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import {
  createScheduleSchema,
  isValidTimeZone,
  nextFireForTriggers,
  parseScheduleListQuery,
  scheduleConversationSeed,
  serializeSchedule,
} from "@/lib/work/schedule";
import { apiTriggerRefusal, normalizeTriggerDrafts } from "@/lib/work/triggers";
import {
  codeRoutineConfigJson,
  codeRoutineFromInput,
  codeRoutineRefusal,
} from "@/lib/work/code-routine";
import { createWorkSession } from "@/lib/work/store";
import { admissionRefusal } from "@/app/api/work/protocol";

export const runtime = "nodejs";



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

  const isCode = body.runKind === "code";
  const codeRefusal = codeRoutineRefusal(body.runKind, body.code, body.target, body.hostId ?? null);
  if (codeRefusal) return NextResponse.json(codeRefusal, { status: 400 });

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
  const apiRefusal = apiTriggerRefusal(drafts.drafts);
  if (apiRefusal) return NextResponse.json(apiRefusal, { status: 400 });

  // Cross-entity ownership is re-checked rather than trusted from the body: a
  // host id or a session id in a request is a claim, and the only thing that
  // makes it true is a row that also carries this user's id.
  //
  // A Code routine names no host and needs no capability, so the whole of this
  // is skipped for one: `admissionRefusal` answers a question about Macs, and
  // asking it about a repository would refuse a perfectly good routine for
  // having no machine that can do local file work.
  if (!isCode) {
    const hosts = await prisma.workHost.findMany({ where: { userId: user.id } });
    const named = body.hostId ? hosts.find((host) => host.id === body.hostId) : undefined;
    if (body.hostId && !named) {
      return NextResponse.json({ error: "Host not found" }, { status: 404 });
    }
    const refusal = admissionRefusal(body.target, named, body.requiredCapabilities ?? [], hosts);
    if (refusal) return NextResponse.json(refusal, { status: 409 });
  }

  // The environment is resolved before the routine is stored, so an id from a
  // picker whose environment was deleted in another tab fails as a 404 the
  // person can act on rather than as a routine that fires at 04:00 into a shape
  // nobody chose. Existence is all that is read — the variables are unsealed
  // once, by runner-context, for the runner alone.
  if (isCode && body.code?.environmentId) {
    const environment = await prisma.codeEnvironment.findFirst({
      where: { id: body.code.environmentId, userId: user.id },
      select: { id: true },
    });
    if (!environment) {
      return NextResponse.json(
        { error: "environment_not_found", message: "That environment no longer exists." },
        { status: 404 }
      );
    }
  }

  if (body.sessionId) {
    const session = await prisma.workSession.findFirst({
      where: { id: body.sessionId, userId: user.id, deletedAt: null },
      select: { id: true },
    });
    if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const sessionId = body.sessionId ?? (await createScheduleSession(user.id, body)).id;

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
      runKind: body.runKind,
      // The parser's output, not the body, for the reason `normalizeTriggerDrafts`
      // gives: what is in the column has to be exactly what the dispatcher will
      // read back, or a routine is accepted at the write and refused at the fire.
      codeConfig: body.code ? codeRoutineConfigJson(codeRoutineFromInput(body.code)) : {},
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

/**
 * The session a new schedule re-runs, and the conversation it writes into.
 *
 * The conversation is the point. A schedule fires into the same session for
 * ever, and since Work stopped being a place that session is only readable
 * through the conversation it points at (docs/design/TWO_PRODUCTS.md §2): the
 * transcript draws the live run, its plan, its questions and its approval
 * cards. Minting the session without one — which is what this route did — left
 * every automation with no web surface whatsoever, so a run that stopped to ask
 * whether it could send the email had nowhere to be answered, and the "Its
 * task" link on its row resolved to the chat index. The column has existed and
 * been serialised to every client since Work shipped (§2.1); only the web
 * create routes never wrote it.
 *
 * Created here rather than at the first fire so the row exists before anything
 * can need it: the schedule row's link, the run rows in the automation editor
 * and the notification email all carry a session id and expect the resolver to
 * find a conversation behind it.
 *
 * Not a transaction with the schedule below. If the schedule's own write fails,
 * what is left is an empty chat and a draft session the user can delete —
 * whereas a transaction spanning both would have to hold one open across the
 * trigger fan-out, and the failure it would protect against is cosmetic.
 *
 * A CODE ROUTINE GETS THE SESSION AND NOT THE CONVERSATION
 *
 * `WorkSchedule.sessionId` is required, and what it points at is the TASK a
 * routine re-runs: its name, the prompt, the model asked for. That is as true
 * of a Code routine as of a Work one, and the row is the only place the task
 * exists once — so it is written for both. What differs is the transcript. A
 * Work routine accumulates its fires in one conversation, and that conversation
 * is the session's own; a Code routine opens a fresh `kind: "code"` session per
 * fire, because each run is a branch and a pull request, and twelve nightly
 * runs in one thread would be twelve unrelated diffs sharing one branch name.
 * So the session of a Code routine carries no `conversationId`, and nothing
 * looks for one: its runs are `CodeTask` rows, each pointing at the
 * conversation that fire opened.
 *
 * NO PROJECT INHERITANCE HERE, and it is an absence rather than an omission: a
 * schedule carries no project — `createScheduleSchema` has no such field and
 * the adopter in scripts/work-scheduler.ts passes none either — so there is
 * nothing for a session minted from one to inherit. The moment a schedule grows
 * a project, `inheritFromProjectDefaults` and `resolveSessionFields` in
 * src/lib/work/projects.ts are what this should call; they are pure and take no
 * request, which is why they live there rather than inside the sessions route.
 */
async function createScheduleSession(
  userId: string,
  body: z.infer<typeof createScheduleSchema>
): Promise<{ id: string }> {
  const conversation =
    body.runKind === "code"
      ? null
      : await prisma.conversation.create({
          data: { userId, ...scheduleConversationSeed(body.name, body.model) },
        });
  return createWorkSession({
    userId,
    title: body.name,
    // "manual" because the user named the schedule themselves; leaving it
    // "default" would let an auto-titler rewrite a name they chose.
    titleSource: "manual",
    goal: body.instructions,
    conversationId: conversation?.id ?? null,
    requestedTarget: body.target,
    preferredHostId: body.hostId ?? null,
    requestedModel: body.model ?? null,
  });
}

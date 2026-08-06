import { NextResponse } from "next/server";
import type { Plan, Prisma, WorkHost } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { isOwnerEmail } from "@/lib/owner";
import { rateLimit } from "@/lib/rate-limit";
import { pickAutoModel } from "@/lib/auto-model";
import { MODEL_LIST, resolveModel } from "@/lib/models";
import { getUserPlan } from "@/lib/usage";
import { canUseModel } from "@/lib/plans";
import {
  WORK_LIVE_STATUSES,
  WORK_PERMISSION_POLICIES,
  WORK_TARGETS,
  resolveApprovalMode,
  selectTarget,
  type HostCapabilityView,
  type WorkBudget,
  type WorkCapability,
  type WorkDegradation,
  type WorkPermissionPolicy,
  type WorkTarget,
} from "@/lib/work/domain";
import { inferCapabilities, selectForInferred } from "@/lib/work/inference";
import {
  cheapestWorkModel,
  defaultWorkModelId,
  isAutoModelId,
  isWorkCapableModel,
  isWorkModelAllowed,
} from "@/lib/work/models";
import {
  createRun,
  recordRunInputsFromGrants,
  type CreateRunResult,
  type RunDrivingCommand,
} from "@/lib/work/store";
import { planRunCommand, refusalBody, startCommandPayload } from "@/lib/work/relay";
import { serializeRun } from "@/lib/work/serializers";
import { effectiveHostState, refusalForSelection, startRunSchema } from "@/app/api/work/protocol";

export const runtime = "nodejs";

// Abuse controls for run dispatch. A run holds an executor — a cloud container
// or a Mac the user is sitting at — for as long as the work takes, so the cost
// of an unbounded client is not a wasted request, it is a fleet.
/** Max runs a user may start per minute. */
const WORK_RUN_RATE_LIMIT = 10;
/** Max simultaneously live runs per user, across every session. */
const WORK_RUN_CONCURRENCY_CAP = 3;

/**
 * Whether cloud Work is accepting runs.
 *
 * A constant because there is one cloud executor and no kill switch in front of
 * it today. It is named and passed to `selectTarget` rather than assumed at the
 * call site so that turning cloud off — a paused executor, a provider outage —
 * is one edit here that produces the honest refusal `selectTarget` already
 * writes, instead of a queue of runs that nothing will ever claim.
 */
const CLOUD_WORK_AVAILABLE = true;

/**
 * The ceilings a run is dispatched with.
 *
 * Nothing wrote these until now, so every column was zero — which
 * `WorkBudget` reads as "no explicit ceiling". The consequence was not
 * theoretical: `WorkBudgetGuard` never fires, `budget_exceeded` and
 * `timed_out` are terminal reasons no run can reach, the three budget bars in
 * the UI render empty, and the only thing bounding a run is
 * `MAX_STEPS_PER_RUN = 200` — two hundred model turns, on a frontier model, on
 * the deployment's key, for a task that may have gone in a circle at step
 * eleven.
 *
 * Each number is a number somebody has to be able to defend, so:
 *
 *  - Two US dollars. A Work run is meant to be worth more than a chat turn and
 *    materially less than a person's hour. Two dollars buys a few hundred
 *    thousand tokens on the models Work admits, which covers research, a draft
 *    and a revision, and stops a loop at the cost of a coffee rather than the
 *    cost of a laptop.
 *  - 600,000 tokens. Deliberately reached at roughly the same time as the cost
 *    ceiling on a mid-priced model, so the two do not disagree about what a
 *    long run is — and so a run on a cheap model is stopped by tokens rather
 *    than running eight times longer for the same money.
 *  - Twenty minutes of *running* time. The guard stops its clock while a run
 *    waits for a person (`WorkBudgetGuard.suspend`), so this is twenty minutes
 *    of work and not twenty minutes of elapsed wall clock — a run that asks a
 *    question at 17:00 and is answered at 09:00 has spent none of it waiting.
 *
 * They are a ceiling and not a target: `narrowestBudget` means a skill, a
 * schedule or a host may lower any of them and none may raise them. Raising
 * them for a particular run is a control that does not exist yet — the field
 * is on `CreateRunInput` and nothing on the wire fills it — so this constant
 * is the whole policy, which is exactly why it is stated here rather than
 * defaulted somewhere quieter.
 */
const DEFAULT_RUN_BUDGET: WorkBudget = {
  maxCostMicroUsd: 2_000_000,
  maxTokens: 600_000,
  maxRuntimeMs: 20 * 60_000,
};

/**
 * What a host can currently do, from what the host itself advertised.
 *
 * Nothing is inferred. A capability the Mac did not claim is a capability it
 * does not have, because the failure of guessing is not a missing feature — it
 * is a run queued at a machine that cannot do the work, which looks exactly
 * like a run about to start.
 *
 * `local_apps` is the one derived entry, and it is derived from the list the
 * user filled in rather than from a toggle: app control with an empty allowlist
 * can drive nothing, so advertising it would offer a capability whose every
 * use is refused.
 */
function hostCapabilityView(host: WorkHost, now: Date): HostCapabilityView {
  const capabilities: WorkCapability[] = [];
  if (host.allowsFileWork) capabilities.push("local_files");
  if (host.allowsBrowser) capabilities.push("local_browser");
  if (host.allowsComputerUse) capabilities.push("local_computer_use");
  if (host.allowsShell) capabilities.push("local_shell");
  if (host.allowsBackground) capabilities.push("background_continuation");
  if (Array.isArray(host.allowedApps) && host.allowedApps.length > 0) capabilities.push("local_apps");

  return {
    hostId: host.id,
    displayName: host.displayName,
    state: effectiveHostState(host, now),
    enabled: host.enabled,
    revoked: host.revokedAt !== null,
    capabilities,
  };
}

/** Narrows a TEXT column to the vocabulary, falling back the way
 *  `serializers.ts` does: never widen a value this build cannot read. */
function targetOf(value: string): WorkTarget {
  return (WORK_TARGETS as readonly string[]).includes(value) ? (value as WorkTarget) : "automatic";
}

function policyOf(value: string): WorkPermissionPolicy {
  return (WORK_PERMISSION_POLICIES as readonly string[]).includes(value)
    ? (value as WorkPermissionPolicy)
    : "conservative";
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

interface RunModel {
  /** What was asked for, verbatim, including the Auto sentinel. */
  requested: string;
  /** A concrete `provider:model` the executor can split and drive. */
  effective: string;
  degradation: WorkDegradation[];
}

/** The reader-facing name of a model id, or the id when nothing knows it. */
function modelLabel(id: string): string {
  return resolveModel(id)?.name ?? id;
}

/**
 * Raised when the account's plan admits no model the agent runtime can drive.
 *
 * Distinct from the throw `pickAutoModel` makes, and answered differently: that
 * one means the deployment has no provider configured, which is nobody's fault
 * on this side of the request, while this one means the reader is not entitled
 * to any model that could run a Work task. One is a 503 and one is a 403, and
 * telling a person to "try again later" when the answer is "this needs a plan"
 * is how a wall gets mistaken for a wobble.
 */
class NoEntitledModelError extends Error {}

/**
 * Decides which model this attempt actually runs on, before the row is written.
 *
 * This is the fix for a bug that killed every cloud run started from a browser.
 * `scripts/work-runner.ts` resolves its provider by splitting the run's model id
 * on `:`, and an empty string throws — "The run has no model" — before the first
 * token. Nothing had ever written `effectiveModel`, and no web client had ever
 * sent `model`, so every one of those runs died in `preparing`. The dispatch
 * route is the right place to end that: it is the only layer holding the goal
 * (which Auto routes on), the account (whose plan bounds the choice), and the
 * authority to refuse rather than queue something that cannot run.
 *
 * Auto is resolved here rather than passed through. The sentinel is a promise to
 * choose, and choosing needs `isProviderConfigured`, which only the server can
 * answer. Resolving it is emphatically NOT a substitution and records no
 * degradation: the reader asked to be routed, and being routed is the answer to
 * that request, not a shortfall in it. A degradation on every Auto run would
 * teach people to ignore the one that matters.
 *
 * What IS a substitution is a model this run cannot actually have — either one
 * the agent runtime cannot drive, or one the account is not entitled to. Auto's
 * own pool guards against neither: it filters for chat, not for
 * `isWorkCapableModel`, so it can land on a Responses-API-only entry the Work
 * runtime has no adapter for; and its last resort abandons the plan filter
 * altogether, so on an account with an empty eligible pool it returns whatever
 * chat model comes first in the catalog. Either way the run proceeds on the
 * cheapest model the account may actually use and says so, because a run that
 * quietly used a different model from the one on its own detail page is a
 * result nobody can account for afterwards.
 *
 * Two different throws, answered two different ways by the caller. `pickAutoModel`
 * throws when the deployment has no configured provider — a 503, nobody's fault
 * on this side. ``NoEntitledModelError`` means the account's plan admits no model
 * that could run a Work task at all — a 403, and a different sentence.
 */
function resolveRunModel(input: { requested: string; goal: string; plan: Plan }): RunModel {
  const auto = isAutoModelId(input.requested);
  const chosen = auto ? pickAutoModel({ message: input.goal, plan: input.plan }).model.id : input.requested;

  const info = resolveModel(chosen);
  // Both halves, and the second one is not redundant. `isWorkModelAllowed`
  // above has already vetted anything the reader *named*, but it lets the Auto
  // sentinel through — and `pickAutoModel`'s last resort ignores the plan
  // entirely, so on an account with an empty eligible pool it hands back a
  // frontier model. Checking only the shape here is what let a free account run
  // an agent loop on the most expensive model in the catalog, on the
  // deployment's key. The resolved id is the only id worth checking.
  if (info && isWorkCapableModel(info) && canUseModel(input.plan, info.id)) {
    return { requested: input.requested, effective: chosen, degradation: [] };
  }

  const fallback = cheapestWorkModel(MODEL_LIST, input.plan);
  if (!fallback) throw new NoEntitledModelError();

  const why =
    info && isWorkCapableModel(info)
      ? `${modelLabel(chosen)} is not included in your plan`
      : `${modelLabel(chosen)} cannot be driven as an agent`;

  return {
    requested: input.requested,
    effective: fallback.id,
    degradation: [
      {
        kind: "model_substituted",
        subject: chosen,
        explanation: auto
          ? `Auto chose ${modelLabel(chosen)}, but ${why}, so this task runs on ${fallback.name} instead.`
          : `${why}, so this task runs on ${fallback.name} instead.`,
      },
    ],
  };
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const session = await prisma.workSession.findFirst({
    where: { id, userId: user.id, deletedAt: null },
  });
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = startRunSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const body = parsed.data;

  // Idempotency is checked before the rate limit and before the cap, so a
  // client retrying a dispatch whose response it never saw gets its run back
  // rather than a 429 for asking twice. `createRun` re-checks the same key
  // under its own unique index; this read is what keeps the retry off the abuse
  // controls, which count attempts, not runs.
  if (body.idempotencyKey) {
    const existing = await prisma.workRun.findFirst({
      where: { userId: user.id, idempotencyKey: body.idempotencyKey },
    });
    if (existing) {
      return NextResponse.json({ run: serializeRun(existing), replay: true }, { status: 200 });
    }
  }

  // The plan gate, on the id this attempt would actually ask for. The session's
  // stored model is checked too, not just the body's: a session drafted while
  // the account was on Pro is still there after it lapses, and dispatching it
  // would be a paid model started by an unpaid account without anybody choosing
  // that. `protocol.ts` deliberately does not check the model against the
  // catalog — the executor may substitute, and a rolling deploy legitimately
  // sees ids this build does not carry — but that is a question about whether
  // the id exists, and this is a question about whether this reader may use it.
  const requestedModel = body.model ?? session.requestedModel ?? defaultWorkModelId();
  const plan = await getUserPlan(user.id);
  if (!isWorkModelAllowed(requestedModel, plan)) {
    return NextResponse.json(
      {
        error: "plan_locked",
        message: "Your plan does not include that model, so nothing was started. Pick another one, or upgrade.",
      },
      { status: 403 }
    );
  }

  const now = new Date();
  const hosts = await prisma.workHost.findMany({ where: { userId: user.id } });
  // Preferred host first: `selectTarget` picks the first fully capable host in
  // the list, so this is how "run it on the MacBook" is expressed to it.
  const ordered = session.preferredHostId
    ? [...hosts].sort((left, right) =>
        left.id === session.preferredHostId ? -1 : right.id === session.preferredHostId ? 1 : 0
      )
    : hosts;

  const requestedTarget = body.requestedTarget ?? targetOf(session.requestedTarget);
  // A client that named capabilities is making a request, and it is honoured
  // exactly as sent — the Mac plans before it dispatches, and second-guessing a
  // plan with a regex would be worse than the regex is good.
  //
  // A client that named none is asking Juno to work it out, which the composer
  // has promised in as many words since it was written and which nothing has
  // ever done: the field said "Leave this empty and Juno works it out from the
  // task", and an empty field meant an empty list, which meant every task was
  // treated as needing nothing local. `inferCapabilities` reads the goal, and
  // the browser runs the same pure function on the same text before the button
  // is pressed, so the sentence the reader saw is the one acted on here.
  //
  // An empty array is treated as absent rather than as an assertion. It is what
  // a client sends when it has nothing to say, not a considered claim that this
  // task needs nothing — and the cost of reading it as one is the bug above.
  //
  // The two are then selected on differently, and that asymmetry is the whole
  // point of separating them. A named capability is a request, and `selectTarget`
  // refuses when nothing can serve a request. An inferred one is a reading of
  // some prose, and `selectForInferred` will not let a reading refuse: it drops
  // the local guesses, runs what the cloud can serve, and says which parts will
  // not happen. Refusing on a regex would mean a person who wrote "tidy my
  // downloads folder" is told, by a machine that was never asked about their
  // computer, that they cannot start — with no chip left to overrule it.
  const explicit = body.requiredCapabilities ?? [];
  const offers = ordered.map((host) => hostCapabilityView(host, now));
  const required: readonly WorkCapability[] =
    explicit.length > 0 ? explicit : inferCapabilities(session.goal).capabilities;
  const selection =
    explicit.length > 0
      ? selectTarget({
          requested: requestedTarget,
          required,
          hosts: offers,
          cloudAvailable: CLOUD_WORK_AVAILABLE,
        })
      : selectForInferred({
          requested: requestedTarget,
          inferred: required,
          hosts: offers,
          cloudAvailable: CLOUD_WORK_AVAILABLE,
        });

  // No executor can serve this. Refusing is the entire reason `selectTarget`
  // returns a null target: a queued run with nothing able to claim it is a
  // spinner that never resolves, and this 409 is the only moment anything in
  // the system is in a position to tell the user why. The explanation is passed
  // through untouched — it already names the Mac and its state, in the words
  // the user is shown.
  const refusal = refusalForSelection(selection);
  if (refusal) return NextResponse.json(refusal, { status: 409 });

  // Before the rate limit, because a deployment with no configured provider is
  // not the reader's fault and should not cost them one of their ten runs a
  // minute to discover.
  let model: RunModel;
  try {
    model = resolveRunModel({ requested: requestedModel, goal: session.goal, plan });
  } catch (err) {
    if (err instanceof NoEntitledModelError) {
      return NextResponse.json(
        {
          error: "plan_locked",
          message:
            "Your plan doesn’t include a model that can run a Work task, so nothing was started.",
        },
        { status: 403 }
      );
    }
    // `pickAutoModel` throws when nothing at all survives its filters. The only
    // honest answer is that nothing was started, and that the reason is on this
    // side: a 500 would send the reader to retry a request that cannot succeed
    // until somebody configures a provider.
    return NextResponse.json(
      {
        error: "no_model_available",
        message: "Juno has no model available to run this right now, so nothing was started.",
      },
      { status: 503 }
    );
  }

  if (!isOwnerEmail(user.email)) {
    const limited = await rateLimit({
      key: `work-run:${user.id}`,
      limit: WORK_RUN_RATE_LIMIT,
      windowSec: 60,
    });
    if (!limited.success) {
      return NextResponse.json({ error: "Too many runs started. Try again shortly." }, { status: 429 });
    }
  }

  const host = selection.hostId ? hosts.find((candidate) => candidate.id === selection.hostId) : undefined;
  // The approval mode this attempt runs under, after narrowing.
  //
  // `resolveApprovalMode` is a `min` over the request and the Mac, so no layer
  // can widen another: a host pinned to Manual stays Manual under a session set
  // to Skip, which is what makes the toggle on the Mac mean anything at all. The
  // body may name a mode for this attempt alone — "it stopped to ask me nine
  // times, run it again and stop asking" — and it goes through the same
  // intersection, so the widest a client can reach is the Mac's own setting.
  //
  // Stored with its inputs because the approval digests are taken over this
  // exact blob, and an approval granted under one mode must be provably
  // distinguishable from the same approval under another.
  const requestedPolicy = body.permissionPolicy ?? policyOf(session.permissionPolicy);
  const mode = resolveApprovalMode({
    requested: requestedPolicy,
    host: host ? policyOf(host.approvalPolicy) : null,
    hostName: host?.displayName ?? null,
  });
  const permissionPolicy: Prisma.InputJsonValue = {
    policy: mode.policy,
    // Each key names the layer it came from, so `session` stays the session's
    // own stored mode even when the body overrode it for this attempt; the
    // override goes in `requested`, and only when there was one. A run
    // dispatched without the new control therefore canonicalises byte-for-byte
    // to what this route has always written. That matters: `policyDigest` is
    // taken over this blob, and adding a key unconditionally would have refused
    // every approval in flight across the deploy with `policy_changed` —
    // failing closed, but closed on a question nobody had changed the answer to.
    session: policyOf(session.permissionPolicy),
    host: mode.host,
    ...(body.permissionPolicy ? { requested: body.permissionPolicy } : {}),
  };

  // The instruction that will actually drive this run, decided before anything
  // is written.
  //
  // A run dispatched to a Mac used to reach `queued` and stop there for ever.
  // `POST /api/work/hosts/[id]/commands` was the only writer of the command
  // queue and nothing here called it, so the Mac long-polled correctly and
  // indefinitely for a `start` that was never enqueued — which is a spinner
  // that never resolves, arriving one layer below the one `selectTarget`
  // exists to prevent.
  //
  // Planned here rather than inside the transaction so that a refusal costs
  // nothing: `selectTarget` has already excluded a Mac that is disabled or
  // revoked, but it read the fleet a few statements ago, and a revocation that
  // landed in between must stop the dispatch rather than leave a run behind
  // with no instruction. Creating the run first and refusing afterwards would
  // be exactly the orphan this whole change exists to make impossible.
  const dispatch = planRunCommand({
    effectiveTarget: selection.target,
    host: host ?? null,
    kind: "start",
  });
  if (dispatch.plan === "refuse") {
    return NextResponse.json(refusalBody(dispatch.refusal), { status: dispatch.refusal.status });
  }
  const command: RunDrivingCommand | undefined =
    dispatch.plan === "enqueue"
      ? {
          hostId: dispatch.hostId,
          kind: "start",
          // The goal comes off the session, which is where the user's own words
          // live; the model is the concrete id resolved above, never the Auto
          // sentinel, because the Mac splits it into a provider and a name and
          // has no catalogue to resolve a sentinel against. The mode is the
          // already-narrowed one — the same value written onto the run and
          // digested into every approval — so the Mac enforces what this task
          // was dispatched under rather than its own standing setting.
          payload: startCommandPayload({
            goal: session.goal,
            model: model.effective,
            permissionPolicy: mode.policy,
          }),
        }
      : undefined;

  let created: CreateRunResult;
  try {
    created = await prisma.$transaction(async (tx) => {
      // The cap and the create are serialised per user by a transactional
      // advisory lock, because a plain count-then-create is a TOCTOU: N
      // parallel dispatches each read a count under the cap and all create.
      //
      // Two details are deliberate. It is the `try` variant, so a second
      // dispatch fails fast instead of queueing — a queue of waiters would each
      // hold a pooled connection while the holder needs a second one for
      // `createRun`, which exhausts the pool under exactly the burst this guard
      // exists for. And `createRun` is called from inside this callback even
      // though it opens its own transaction: that transaction commits before
      // this one releases the lock, so the next dispatch through here counts
      // the run this one just made. Moving the insert inline would mean
      // reimplementing attempt allocation and idempotency recovery, and those
      // are the two things that must never disagree with the store.
      const [lock] = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtext(${`work-run-cap:${user.id}`})) AS locked
      `;
      if (!lock?.locked) throw new Error("dispatch_in_flight");

      const live = await tx.workRun.count({
        where: { userId: user.id, status: { in: [...WORK_LIVE_STATUSES] } },
      });
      if (live >= WORK_RUN_CONCURRENCY_CAP) {
        throw Object.assign(new Error("run_cap_exceeded"), { liveCount: live });
      }

      // One live run per session. A second attempt started while the first is
      // still going means two executors planning against one goal and writing
      // to the same granted folders, and the user watching one transcript while
      // two things happen. Retrying means cancelling first, which is a decision
      // only they can make.
      const alreadyLive = await tx.workRun.count({
        where: { sessionId: session.id, userId: user.id, status: { in: [...WORK_LIVE_STATUSES] } },
      });
      if (alreadyLive > 0) throw new Error("session_already_running");

      return createRun({
        sessionId: session.id,
        userId: user.id,
        origin: body.origin ?? "manual",
        requestedTarget,
        effectiveTarget: selection.target,
        hostId: selection.hostId,
        // Both, always. `requestedModel` is what was asked for and may be the
        // Auto sentinel; `effectiveModel` is the concrete id the executor
        // splits into a provider and a model name. Keeping only one of them
        // would lose the difference between a run that asked for Opus and a run
        // that asked to be routed and was routed to it.
        requestedModel: model.requested,
        effectiveModel: model.effective,
        requiredCapabilities: required,
        availableCapabilities: selection.available,
        // Carried onto the run so the client can show, before any work starts,
        // that this attempt will do less than was asked. Recomputing it later
        // describes the fleet as it is then, not as it was at dispatch. The
        // model's degradation joins the target's here rather than being kept
        // apart: from the reader's side there is one list of ways this run
        // differs from the one they asked for.
        degradation: [...selection.degradation, ...model.degradation],
        permissionPolicy,
        // The ceilings the executor's budget guard enforces and the three bars
        // in the UI read. Written at dispatch rather than derived later,
        // because an approval digest and a budget bar both have to describe
        // the run as it was started, not as the defaults happen to be today.
        budget: DEFAULT_RUN_BUDGET,
        idempotencyKey: body.idempotencyKey ?? null,
        // Written in the run's own transaction, so this attempt cannot exist
        // without the instruction that drives it, nor the instruction without
        // the run it names.
        command,
      });
    });
  } catch (err) {
    if (err instanceof Error && err.message === "dispatch_in_flight") {
      return NextResponse.json(
        { error: "dispatch_in_flight", message: "Another run is being started. Try again in a moment." },
        { status: 429 }
      );
    }
    if (err instanceof Error && err.message === "run_cap_exceeded") {
      const live = (err as Error & { liveCount?: number }).liveCount ?? WORK_RUN_CONCURRENCY_CAP;
      return NextResponse.json(
        {
          error: "run_cap_exceeded",
          message: `You already have ${live} runs in progress. Let one finish first.`,
        },
        { status: 429 }
      );
    }
    if (err instanceof Error && err.message === "session_already_running") {
      return NextResponse.json(
        {
          error: "session_already_running",
          message: "This session is already running. Cancel it before starting another attempt.",
        },
        { status: 409 }
      );
    }
    throw err;
  }

  if (!created.replay) {
    // The files this attempt is being given, frozen onto the run. Skipped on a
    // replay because a replayed dispatch is the same run, and its manifest was
    // written when the run was — writing it twice would show the reader every
    // attachment twice for no reason they could work out.
    await recordRunInputsFromGrants({
      runId: created.run.id,
      sessionId: session.id,
      userId: user.id,
    });

    // The thinking depth, when this attempt asked for one. It lands on the
    // session rather than the run because `WorkRun` has no column for it, which
    // means — unlike `requestedTarget` — it is not attempt-scoped: setting it
    // here changes it for the next attempt too. That is a schema gap, not a
    // decision, and it is written down here rather than left to be rediscovered
    // by whoever notices their retry thinking as hard as the run before it.
    if (body.reasoningEffort !== undefined && body.reasoningEffort !== session.reasoningEffort) {
      await prisma.workSession.updateMany({
        where: { id: session.id, userId: user.id },
        data: { reasoningEffort: body.reasoningEffort },
      });
    }
  }

  return NextResponse.json(
    {
      run: serializeRun(created.run),
      selection: {
        target: selection.target,
        hostId: selection.hostId,
        explanation: selection.explanation,
        missing: selection.missing,
        degradation: selection.degradation,
      },
      // The mode this attempt will actually run under, answered at the moment
      // it is decided. The composer needs it because the one thing it must not
      // do is show Skip on a task that is about to run Manual — a person who
      // chose Skip and then watches it stop to ask has been lied to by a
      // control, and the honest version of that is a sentence naming the Mac
      // that narrowed it. `explanation` is that sentence, already addressed to
      // the reader.
      //
      // Only the resolved shape goes out, never the stored blob: that blob is
      // what the executor enforces and what the approval digests are taken over,
      // and a client that renders it is one refactor away from a client that
      // submits it.
      approvalMode: {
        policy: mode.policy,
        requested: mode.requested,
        narrowedByHost: mode.narrowedByHost,
        explanation: mode.explanation,
      },
      ...(created.replay ? { replay: true } : {}),
    },
    { status: created.replay ? 200 : 201 }
  );
}

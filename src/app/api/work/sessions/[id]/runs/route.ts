import { NextResponse } from "next/server";
import type { Plan, Prisma, WorkHost } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { isOwnerEmail } from "@/lib/owner";
import { rateLimit } from "@/lib/rate-limit";
import { MODEL_LIST, resolveModel } from "@/lib/models";
import { configuredProviders } from "@/lib/providers";
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
  defaultWorkModelId,
  isAutoModelId,
  isWorkCapableModel,
  isWorkModelAllowed,
  pickWorkModel,
  workFailoverModels,
  workModelOptions,
} from "@/lib/work/models";
import {
  createRun,
  recordRunInputsFromGrants,
  WorkSpendAdmissionError,
  type CreateRunResult,
  type RunDrivingCommand,
} from "@/lib/work/store";
import { planRunCommand, refusalBody, startCommandPayload } from "@/lib/work/relay";
import { serializeRun } from "@/lib/work/serializers";
import {
  effectiveHostState,
  parseSessionRunListQuery,
  refusalForSelection,
  startRunSchema,
} from "@/app/api/work/protocol";
import { estimateWorkRunCost } from "@/lib/work/preflight-cost";

export const runtime = "nodejs";

// Abuse controls for run dispatch. A run holds an executor — a cloud container
// or a Mac the user is sitting at — for as long as the work takes, so the cost
// of an unbounded client is not a wasted request, it is a fleet.
/** Max runs a user may start per minute. */
const WORK_RUN_RATE_LIMIT = 10;
/** Max simultaneously live runs per user, across every session. */
const WORK_RUN_CONCURRENCY_CAP = 3;
/**
 * How many previous failures a retry looks back over when choosing a model.
 *
 * Bounded so a task retried thirty times does not send a thirty-item `NOT IN`
 * to the router, and so a model that failed once a month ago is eligible again
 * — the pool is not large, and permanently retiring a model from a task on one
 * bad afternoon would eventually leave nothing to run it on.
 */
const MAX_FAILOVER_HISTORY = 4;

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
 * Raised when this deployment can reach no model the agent runtime can drive —
 * every lab that carries one is unconfigured.
 *
 * The other half of the pair above, and the reason the router is not allowed to
 * answer both with a bare `null`: one of these is a wall in front of the reader
 * and the other is a wall in front of the operator, and telling somebody to
 * upgrade their plan when the truth is that nobody set an API key sends them to
 * a checkout page that will not help.
 */
class NoReachableModelError extends Error {}

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
 * the agent runtime cannot drive, or one the account is not entitled to. The run
 * proceeds on the best model the account may actually use and says so, because a
 * run that quietly used a different model from the one on its own detail page is
 * a result nobody can account for afterwards.
 *
 * **Auto routes through `pickWorkModel`, not `pickAutoModel`.** It used to be
 * the latter, and that is the whole of how the reported incident began. The chat
 * router grades a sentence for the job chat does and ranks the survivors
 * cheapest-first; asked to route "clean my github & add readme on projects that
 * doesn't have one" it scored `simple` / `minIntelligence: 4` and returned the
 * cheapest model in the catalog clearing a 4 — measured on this catalog, one
 * billing an average of zero, which is a free tier, which is the tier with the
 * tightest rate limits. The run made one tool call and died against a 429 it had
 * no way to survive. `pickWorkModel` states Work's own floor, ranks within the
 * pool this deployment can actually reach, and breaks ties on capability rather
 * than on the first letter of a marketing name. See `src/lib/work/models.ts`.
 *
 * Two different throws, answered two different ways by the caller.
 * ``NoReachableModelError`` means no lab carrying a drivable model is configured
 * — a 503, nobody's fault on this side. ``NoEntitledModelError`` means the
 * account's plan admits no model that could run a Work task at all — a 403, and
 * a different sentence.
 */
function resolveRunModel(input: {
  requested: string;
  goal: string;
  plan: Plan;
  /** Models earlier attempts at this task already failed on. Auto only. */
  spentModels?: readonly string[];
}): RunModel {
  const providers = configuredProviders();
  const spent = input.spentModels ?? [];

  // Asked before anything else, because "this deployment can reach no drivable
  // model" and "your plan includes no drivable model" are the 503 and the 403,
  // and a single null from the router below cannot tell them apart. Reading the
  // reachable pool first is what keeps those two answers distinct.
  if (workModelOptions(MODEL_LIST, { providers }).length === 0) {
    throw new NoReachableModelError();
  }

  const auto = isAutoModelId(input.requested);

  if (auto) {
    // A retry of a task that already failed on one or more models moves to a
    // different lab rather than repeating the attempt that just died. The
    // ordering prefers a provider this task has not met yet, because the failure
    // this exists for — a rate limit — belongs to the lab and not to the model,
    // and the second-best model on the same key meets the same quota.
    if (spent.length > 0) {
      const [next] = workFailoverModels({
        goal: input.goal,
        plan: input.plan,
        models: MODEL_LIST,
        providers,
        exclude: spent,
      });
      if (next) {
        const previous = modelLabel(spent[0]);
        return {
          requested: input.requested,
          effective: next.id,
          degradation: [
            {
              kind: "model_substituted",
              subject: next.id,
              explanation:
                spent.length === 1
                  ? `The last attempt failed on ${previous}, so this one runs on ${next.name} instead.`
                  : `Earlier attempts failed on ${spent.length} other models, so this one runs on ${next.name}.`,
            },
          ],
        };
      }
      // Nothing left to move to. Falling through runs the ordinary choice again,
      // which is right: a task whose whole eligible pool has failed should still
      // be allowed one more go rather than be refused, and the reader pressed
      // the button knowing the last attempt failed.
    }

    const pick = pickWorkModel({
      goal: input.goal,
      plan: input.plan,
      models: MODEL_LIST,
      providers,
    });
    if (!pick) throw new NoEntitledModelError();
    return {
      requested: input.requested,
      effective: pick.model.id,
      // Routing is the answer to the request rather than a shortfall in it, so
      // an ordinary Auto run records nothing — see the docstring. The single
      // exception is a floor that could not be met, because that genuinely
      // changes what the reader should expect the run to get through.
      degradation: pick.relaxed
        ? [
            {
              kind: "model_substituted",
              subject: pick.model.id,
              explanation: `This task reads like it needs a more capable model than your plan includes, so it runs on ${pick.model.name}. It may take more steps, or stop short of the whole job.`,
            },
          ]
        : [],
    };
  }

  // A model the reader named. `isWorkModelAllowed` has already vetted the plan
  // for it; this re-checks on the resolved id, which is the only id worth
  // checking once `resolveModel` has had the chance to migrate a retired one.
  const info = resolveModel(input.requested);
  if (info && isWorkCapableModel(info) && canUseModel(input.plan, info.id)) {
    return { requested: input.requested, effective: info.id, degradation: [] };
  }

  const fallback = pickWorkModel({
    goal: input.goal,
    plan: input.plan,
    models: MODEL_LIST,
    providers,
  });
  if (!fallback) throw new NoEntitledModelError();

  const why =
    info && isWorkCapableModel(info)
      ? `${modelLabel(input.requested)} is not included in your plan`
      : `${modelLabel(input.requested)} cannot be driven as an agent`;

  return {
    requested: input.requested,
    effective: fallback.model.id,
    degradation: [
      {
        kind: "model_substituted",
        subject: input.requested,
        explanation: `${why}, so this task runs on ${fallback.model.name} instead.`,
      },
    ],
  };
}

/**
 * Every attempt this task has made.
 *
 * A retry is an experiment, and the attempts panel on the detail page is the
 * only place the previous conditions are readable: did it get further this
 * time, did it cost more, did it run somewhere else, was it the same model.
 * Every one of those attempts has always existed as its own `WorkRun` row —
 * nothing new is recorded here, it is only read back. Until this handler
 * existed the panel's fetch answered 405 on every multi-attempt task and the
 * panel fell back to a sentence apologising for history it was sitting on.
 *
 * Ordered by `attempt` rather than by `createdAt`, which is the one deliberate
 * difference from the sibling schedule handler. `attempt` is what a person
 * means by "the second try", it is what the panel labels each row with, and
 * `@@unique([sessionId, attempt])` both guarantees it is a total order within
 * the session and serves the sort from an index. `createdAt` is the right key
 * for a schedule, whose runs belong to no numbered sequence; here it would be a
 * second, weaker answer to a question `attempt` already answers exactly.
 *
 * The current attempt is included rather than filtered out. The panel marks it
 * "this one" and needs it in the same list to do so, and a client asking for a
 * task's attempts and getting all but one of them would be the more surprising
 * contract.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const { limit } = parseSessionRunListQuery(new URL(req.url).searchParams);

  // The session is looked up first even though the run query is scoped by
  // `sessionId` and `userId` anyway, so an id belonging to somebody else
  // answers 404 rather than an empty list — an empty list is indistinguishable
  // from a task that has never run, and confirms the id exists. Soft-deleted
  // sessions are 404 here for the same reason they are in POST and in the
  // detail route: the page that would render this panel is already gone.
  const session = await prisma.workSession.findFirst({
    where: { id, userId: user.id, deletedAt: null },
    select: { id: true },
  });
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const runs = await prisma.workRun.findMany({
    where: { userId: user.id, sessionId: id },
    // Newest attempt first, which is what the panel opens on and the direction
    // it reads backwards from.
    orderBy: { attempt: "desc" },
    take: limit,
  });

  return NextResponse.json({ runs: runs.map(serializeRun) });
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
  /*
   * Models this task has already burned an attempt on.
   *
   * This is failover, and it is deliberately here rather than inside the agent
   * loop. Swapping a model mid-run cannot be done honestly: `provider` and
   * `model` are fixed `AgentLoopOptions`, and three things are bound alongside
   * them at construction — the budget guard's `pricing`, the reasoning tier
   * clamped for the old model's enum, and the `run_started` event that already
   * told the transcript which model was answering. A mid-loop swap would bill
   * the new model's tokens at the old one's rate, risk an instant 400 from a lab
   * whose thinking dialect differs, and leave the record naming a model that
   * stopped being true. A new attempt has none of those problems, because every
   * one of them is rebuilt.
   *
   * Only for Auto. A reader who named a model is owed that model or a refusal —
   * quietly running their task somewhere else is the substitution the whole
   * degradation vocabulary exists to prevent. And only across *failed* attempts:
   * a cancelled run was somebody's decision, not the model's failure.
   */
  const spentModels = isAutoModelId(requestedModel)
    ? (
        await prisma.workRun.findMany({
          where: {
            sessionId: session.id,
            userId: user.id,
            status: { in: ["failed", "timed_out"] },
          },
          select: { effectiveModel: true },
          orderBy: { attempt: "desc" },
          take: MAX_FAILOVER_HISTORY,
        })
      )
        .map((run) => run.effectiveModel)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];

  let model: RunModel;
  try {
    model = resolveRunModel({
      requested: requestedModel,
      goal: session.goal,
      plan,
      spentModels,
    });
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
    // `NoReachableModelError`, or anything unexpected out of the router. The
    // only honest answer is that nothing was started and the reason is on this
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

  const preflight = estimateWorkRunCost({ modelId: model.effective, goalChars: session.goal.length });
  if (preflight.requiresConfirmation && !body.confirmExpensive) {
    return NextResponse.json(
      {
        error: "expensive_confirmation_required",
        message: `This task is estimated at about $${(preflight.estimatedCostMicroUsd / 1_000_000).toFixed(2)} before it starts. Confirm to use the Work budget and continue.`,
        confirmation: {
          kind: "expensive_work",
          estimatedCostMicroUsd: preflight.estimatedCostMicroUsd,
          modelId: preflight.modelId,
        },
      },
      { status: 409 }
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
    if (err instanceof WorkSpendAdmissionError) {
      const message =
        err.result.refusedBy === "unit"
          ? "This task is above Juno’s per-run spending ceiling, so nothing was started. Lower its scope or choose a less expensive model."
          : "Starting this task would exceed your current spending ceiling, so nothing was started. Finish or stop another run, or lower the account cap.";
      return NextResponse.json(
        {
          error: "spend_cap_exceeded",
          message,
          budgetMicroUsd: err.result.budgetMicroUsd,
          remainingMicroUsd: err.result.remainingMicroUsd,
          estimateMicroUsd: err.result.estimateMicroUsd,
          capSource: err.result.capSource,
        },
        { status: 429 }
      );
    }
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
      preflight,
    },
    { status: created.replay ? 200 : 201 }
  );
}

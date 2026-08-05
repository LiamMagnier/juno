/**
 * The cloud Work executor.
 *
 * Claims queued cloud runs, drives the Work agent runtime, streams what happens
 * into WorkEvent, and ends every run with an authoritative terminal reason.
 * Run it the way the scheduled-task worker is run:
 *
 *     npm run work:runner
 *
 * Three things shape the design, and all three come from the same fact: a Work
 * run outlives the process that started it.
 *
 * It leases rather than flags. `claimRun` puts the condition in the UPDATE's
 * WHERE so exactly one worker wins, and the lease expires so a worker that dies
 * does not strand its run in `running` for ever. This process renews its own
 * leases while it works and sweeps everyone else's expired ones on the way in.
 *
 * It waits for a person without holding the executor hostage. A question or an
 * approval suspends the run; if the answer arrives in the next few minutes the
 * run continues in place, and if it does not, the run is checkpointed, released
 * and picked up later by whichever worker is free. A design that blocked
 * indefinitely would mean one unanswered question costs a worker until someone
 * comes back from lunch.
 *
 * It never restarts a run on its own. A Work run can have moved files, sent a
 * message or spent most of a budget before it stopped, and repeating those is
 * worse than stopping. `interrupted` is a terminal state with a retry the user
 * chooses.
 */

import "server-only";

import { prisma, prismaUnguarded } from "@/lib/db";
import {
  appendEvents,
  claimRun,
  finishRun,
  reclaimStalledRuns,
  setSessionAttention,
} from "@/lib/work/store";
import { verifyApproval } from "@/lib/work/digests";
import { recordWorkAudit } from "@/lib/work/audit";
import {
  RUN_LEASE_MS,
  defaultVisibilityFor,
  isWorkEventKind,
  type WorkEventKind,
  type WorkTerminalReason,
} from "@/lib/work/domain";
import type { Prisma } from "@prisma/client";

/** How often to look for work. */
const TICK_MS = 5_000;
/** How many runs one worker will drive at once. */
const MAX_CONCURRENT_RUNS = 3;
/** Renew a lease at a third of its life, so two renewals may fail harmlessly. */
const LEASE_RENEW_MS = Math.floor(RUN_LEASE_MS / 3);
/**
 * How long the executor stays attached while a question or approval is
 * outstanding before checkpointing and letting the run go.
 *
 * Long enough that a user who is watching answers in place — reattaching costs
 * a cold start and the user sees a stall — and short enough that a question
 * asked at 17:59 does not hold a worker overnight.
 */
const ATTENDED_WAIT_MS = 4 * 60_000;
/** How often to look for the answer while attached. */
const ANSWER_POLL_MS = 1_000;

/** A stable identity for this worker, recorded on every lease it takes. */
const EXECUTOR_ID = `work-runner:${process.pid}:${process.env.HOSTNAME ?? "local"}`;

let stopping = false;
const active = new Map<string, { renew: NodeJS.Timeout }>();

function log(message: string, extra?: Record<string, unknown>): void {
  const suffix = extra ? ` ${JSON.stringify(extra)}` : "";
  console.log(`[work-runner] ${message}${suffix}`);
}

// ---------------------------------------------------------------------------
// Leases
// ---------------------------------------------------------------------------

/**
 * Keeps this worker's claim on a run alive while it is being driven.
 *
 * Renewal is a guarded conditional update, not a blind write: if the lease has
 * already expired and another worker took the run, this must not steal it back.
 * The condition is what makes the reclaim sweep safe to run everywhere at once.
 */
function startLeaseRenewal(runId: string, userId: string): NodeJS.Timeout {
  return setInterval(() => {
    const now = new Date();
    void prisma.workRun
      .updateMany({
        where: {
          id: runId,
          userId,
          claimedBy: EXECUTOR_ID,
          status: { in: ["preparing", "running", "waiting_input", "waiting_approval"] },
        },
        data: { leaseExpiresAt: new Date(now.getTime() + RUN_LEASE_MS) },
      })
      .catch((error: unknown) => {
        // A failed renewal is not fatal on its own — the next one may succeed,
        // and if none do the lease expires and the sweep ends the run honestly.
        log("lease renewal failed", { runId, error: String(error) });
      });
  }, LEASE_RENEW_MS);
}

// ---------------------------------------------------------------------------
// Waiting for a person
// ---------------------------------------------------------------------------

type WaitOutcome<T> = { answered: true; value: T } | { answered: false };

/**
 * Polls for something a person has to do, giving up after `ATTENDED_WAIT_MS`.
 *
 * Polling rather than a listener because the answer can arrive at any of three
 * places — the website, a phone, or the Mac — and the only thing all three
 * already write to is the database. A notification channel would be a fourth
 * thing to keep correct, and the poll interval is a second.
 */
async function waitFor<T>(
  probe: () => Promise<T | null>,
  deadlineMs: number
): Promise<WaitOutcome<T>> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until && !stopping) {
    const value = await probe();
    if (value !== null) return { answered: true, value };
    await new Promise((resolve) => setTimeout(resolve, ANSWER_POLL_MS));
  }
  return { answered: false };
}

/**
 * The answer to a question the run asked.
 *
 * Read from the event stream rather than a dedicated column, because the answer
 * belongs in the transcript anyway: the model must see it as a tool result, and
 * a client replaying the run must see it in order. Two representations of one
 * answer is one representation too many.
 */
async function pollAnswer(runId: string, questionId: string): Promise<string | null> {
  const event = await prismaUnguarded.workEvent.findFirst({
    where: { runId, kind: "question_answered" },
    orderBy: { seq: "desc" },
  });
  if (!event) return null;
  const payload = event.payload as { questionId?: string; answer?: string } | null;
  if (!payload || payload.questionId !== questionId) return null;
  return typeof payload.answer === "string" ? payload.answer : null;
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

/**
 * Finds cloud runs nobody is driving.
 *
 * Cross-account by nature, so it says so with `prismaUnguarded` rather than
 * tripping a guard whose entire job is to notice a query that forgot its
 * userId. Ordered oldest-first: a run that has been queued longest is the one a
 * user is most likely to have given up on.
 */
async function findQueuedRuns(limit: number) {
  return prismaUnguarded.workRun.findMany({
    where: {
      status: "queued",
      effectiveTarget: "cloud",
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: new Date() } }],
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, userId: true, sessionId: true },
  });
}

async function tick(): Promise<void> {
  // Other workers' casualties first. A run whose executor died is invisible to
  // every surface as anything other than "still going", so clearing it is more
  // urgent than starting something new.
  const swept = await reclaimStalledRuns({ limit: 50 });
  if (swept.reclaimed.length > 0) {
    log("reclaimed stalled runs", { count: swept.reclaimed.length });
  }

  const slots = MAX_CONCURRENT_RUNS - active.size;
  if (slots <= 0) return;

  for (const candidate of await findQueuedRuns(slots)) {
    if (stopping) return;
    const claim = await claimRun({
      runId: candidate.id,
      userId: candidate.userId,
      executorId: EXECUTOR_ID,
    });
    if (!claim.claimed) continue;

    const renew = startLeaseRenewal(candidate.id, candidate.userId);
    active.set(candidate.id, { renew });
    // Deliberately not awaited: the tick loop keeps sweeping and claiming while
    // runs are in flight. Failures are handled inside drive(), which always
    // reaches finishRun.
    void drive(candidate.id, candidate.userId).finally(() => {
      clearInterval(renew);
      active.delete(candidate.id);
    });
  }
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * Resolves the model adapter for a run.
 *
 * A canonical model id here is "provider:model", the same shape the rest of
 * Juno uses, so the provider half selects the adapter and the model half is
 * handed to it.
 *
 * NOT YET WIRED: the backend-proxied path. In production a cloud run should
 * reach models through the Juno proxy with a per-run scoped token, exactly as
 * scripts/cloud-code-runner.mjs does — it exchanges a dispatch code for runner
 * context, fetches the model catalog, and builds `createProxyProvider` from it,
 * which is what keeps provider credentials out of the executor entirely. That
 * handshake needs a per-run token this queue does not yet mint, so today this
 * resolves a directly-configured provider from the environment instead. The
 * consequence is real and worth stating plainly: this worker holds a provider
 * key, where the Code runner does not.
 */
async function resolveProvider(canonicalModelId: string) {
  const [providerId] = canonicalModelId.split(":");
  if (!providerId) {
    throw new Error(
      `The run has no model. Set one on the session, or a default for the account.`
    );
  }
  const { createProvider } = (await import(
    "../runner/agent-core/dist/providers/registry.js"
  )) as unknown as typeof import("../runner/agent-core/src/providers/registry.js");
  return createProvider(providerId);
}

// ---------------------------------------------------------------------------
// Driving one run
// ---------------------------------------------------------------------------

/**
 * Drives a claimed run to a terminal state.
 *
 * Every exit path calls `finishRun`. A run that ends without one is a row that
 * says `running` for ever and a task the user watches spin, so the catch is not
 * defensive tidiness — it is the only thing standing between an unexpected
 * throw and a permanently stuck session.
 */
async function drive(runId: string, userId: string): Promise<void> {
  let seq = 0;
  const emit = async (
    kind: WorkEventKind,
    payload: Prisma.InputJsonValue
  ): Promise<void> => {
    seq += 1;
    await appendEvents({
      runId,
      userId,
      events: [
        {
          kind,
          payload,
          visibility: defaultVisibilityFor(kind),
          key: `${runId}:${EXECUTOR_ID}:${seq}`,
        },
      ],
    }).catch((error: unknown) => {
      // An event that cannot be written must not take the run down with it: the
      // transcript is worth less than the work, and a gap is visible to the
      // client's gap detector.
      log("event append failed", { runId, kind, error: String(error) });
    });
  };

  try {
    await emit("run_started", { executor: "cloud" });

    const outcome = await execute({ runId, userId, emit });

    await finishRun({
      runId,
      userId,
      reason: outcome.reason,
      detail: outcome.detail,
    });
    await emit("run_finished", { reason: outcome.reason });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("run failed", { runId, error: message });
    await emit("error", { message });
    await finishRun({ runId, userId, reason: "failed", detail: message }).catch(
      (finishError: unknown) => {
        // The last line of defence has itself failed. Nothing further can be
        // done in-process; the lease will expire and the sweep will end the run.
        log("could not record the failure", { runId, error: String(finishError) });
      }
    );
  }
}

interface ExecuteInput {
  runId: string;
  userId: string;
  emit(kind: WorkEventKind, payload: Prisma.InputJsonValue): Promise<void>;
}

interface ExecuteOutcome {
  reason: WorkTerminalReason;
  detail: string;
}

/**
 * Loads the run's configuration and drives the agent runtime.
 *
 * Split from `drive` so that the terminal-state guarantee above holds over
 * everything this does, including the parts that talk to a model provider.
 *
 * The runtime import is dynamic and deep, matching how the cloud Code runner
 * already reaches the vendored core: runner/agent-core is built standalone in
 * CI and is outside the root tsconfig, so a static import would make the web
 * build depend on a directory it does not typecheck.
 */
async function execute(input: ExecuteInput): Promise<ExecuteOutcome> {
  const run = await prisma.workRun.findFirst({
    where: { id: input.runId, userId: input.userId },
    include: { session: true },
  });
  if (!run) return { reason: "failed", detail: "The run disappeared after it was claimed." };

  await setSessionAttention({
    sessionId: run.sessionId,
    userId: input.userId,
    status: "running",
  });
  await prisma.workRun.updateMany({
    where: { id: input.runId, userId: input.userId },
    data: { status: "running" },
  });

  // Typed through `unknown`: the compiled surface and the source surface
  // declare the same classes separately, so their private fields make the two
  // structurally incomparable even though they are the same code. The runtime
  // is the artefact CI builds and tests, and this is the seam where that fact
  // has to be stated rather than argued with.
  const runtime = (await import(
    "../runner/agent-core/dist/work/index.js"
  )) as unknown as typeof import("../runner/agent-core/src/work/index.js");

  const budget = {
    maxCostMicroUsd: run.maxCostMicroUsd,
    maxTokens: run.maxTokens,
    maxRuntimeMs: run.maxRuntimeMs,
  };

  const plan = new runtime.WorkPlan([
    { id: "understand", title: "Understand what is being asked" },
    { id: "work", title: "Do the work" },
    { id: "verify", title: "Check the result against the request" },
  ]);

  const provider = await resolveProvider(run.effectiveModel ?? run.requestedModel ?? "");

  const session = new runtime.WorkAgentSession({
    runId: input.runId,
    goal: run.session.goal,
    provider,
    // The adapter was selected by the provider half; it wants the model half.
    model: (run.effectiveModel ?? run.requestedModel ?? "").split(":").slice(1).join(":"),
    cwd: process.cwd(),
    tools: [],
    plan,
    budget,
    permissionPolicy: (run.permissionPolicy ?? {}) as Record<string, unknown>,
    callbacks: {
      onEvent: (event) => {
        // Narrowed rather than cast. The runtime and the database share a
        // vocabulary by generation, but a runtime built from a newer commit
        // could emit a kind this deployment has no column value for, and
        // writing it anyway produces an event no client will ever render.
        if (!isWorkEventKind(event.kind)) {
          log("dropping an event kind this build does not know", {
            runId: input.runId,
            kind: event.kind,
          });
          return;
        }
        void input.emit(event.kind, event as unknown as Prisma.InputJsonValue);
      },
      onAudit: (intent) => {
        void recordWorkAudit({
          userId: input.userId,
          sessionId: run.sessionId,
          runId: input.runId,
          kind: intent.kind,
          severity: intent.severity,
          detail: intent.detail,
          actor: "cloud_runner",
        });
      },
      askQuestion: async (question) => {
        await prisma.workRun.updateMany({
          where: { id: input.runId, userId: input.userId },
          data: { status: "waiting_input" },
        });
        await setSessionAttention({
          sessionId: run.sessionId,
          userId: input.userId,
          status: "waiting_input",
        });
        const waited = await waitFor(
          () => pollAnswer(input.runId, question.id),
          ATTENDED_WAIT_MS
        );
        if (!waited.answered) {
          // Release rather than block. The run is checkpointed by the runtime's
          // own pause path, and whichever worker is free picks it up once the
          // answer lands.
          session.pause("Waiting for an answer.");
          throw new Error("paused-waiting-for-answer");
        }
        await prisma.workRun.updateMany({
          where: { id: input.runId, userId: input.userId },
          data: { status: "running" },
        });
        return waited.value;
      },
      requestApproval: async (request) => {
        const approval = await prisma.workApproval.create({
          data: {
            runId: input.runId,
            userId: input.userId,
            action: request.action,
            risk: request.risk,
            summary: request.summary,
            detail: request.detail as never,
            actionDigest: request.actionDigest,
            policyDigest: request.policyDigest,
            expiresAt: new Date(request.expiresAt),
          },
        });
        await prisma.workRun.updateMany({
          where: { id: input.runId, userId: input.userId },
          data: { status: "waiting_approval" },
        });
        await setSessionAttention({
          sessionId: run.sessionId,
          userId: input.userId,
          status: "waiting_approval",
        });

        const waited = await waitFor(async () => {
          const row = await prisma.workApproval.findFirst({
            where: { id: approval.id, userId: input.userId, decision: { not: "pending" } },
          });
          return row ?? null;
        }, ATTENDED_WAIT_MS);

        if (!waited.answered) {
          session.pause("Waiting for an approval.");
          throw new Error("paused-waiting-for-approval");
        }

        // Recomputed here, not trusted from the row. The approval travelled to
        // a phone and back; without recomputing, an answer to one action is
        // indistinguishable from an answer replayed against another.
        const verdict = verifyApproval({
          storedDigest: waited.value.actionDigest,
          storedPolicyDigest: waited.value.policyDigest,
          action: request.action,
          detail: JSON.parse(request.digestInput) as unknown,
          policy: (run.permissionPolicy ?? {}) as unknown,
          decision: waited.value.decision as never,
          expiresAt: waited.value.expiresAt,
          now: new Date(),
        });

        await prisma.workRun.updateMany({
          where: { id: input.runId, userId: input.userId },
          data: { status: "running" },
        });

        if (!verdict.ok) {
          await recordWorkAudit({
            userId: input.userId,
            sessionId: run.sessionId,
            runId: input.runId,
            kind: "approval_replay_refused",
            severity: "refusal",
            detail: { approvalId: approval.id, reason: verdict.reason },
            actor: "cloud_runner",
          });
          // A refused verification is a denial, not an error: the tool call is
          // rejected and the model is told, which is exactly what happens when
          // a person says no. An exception here would end a run over something
          // the run is allowed to recover from.
          return verdict.reason === "expired" ? "expired" : "denied";
        }
        return waited.value.decision === "allowed_always" ? "allowed_always" : "allowed";
      },
    },
  });

  try {
    const result = await session.run();
    if (result.state === "paused") {
      return { reason: "interrupted", detail: "Paused while waiting for the user." };
    }
    return { reason: result.terminalReason, detail: result.detail };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("paused-waiting-for")) {
      // Not a failure. The run is parked and answerable; the next tick that
      // sees an answer will resume it.
      return {
        reason: "interrupted",
        detail: "Released while waiting for you. It will continue once you answer.",
      };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log("started", { executor: EXECUTOR_ID, concurrency: MAX_CONCURRENT_RUNS });

  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} received, finishing in-flight runs`);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  while (!stopping) {
    try {
      await tick();
    } catch (error) {
      // One bad tick must not end the worker: the next one may well succeed,
      // and a worker that exits on a transient database error takes every
      // queued run with it.
      log("tick failed", { error: String(error) });
    }
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }

  // Leases are left to expire rather than released. A worker shutting down
  // mid-run has not finished the work, and handing the run straight back would
  // start it again from the beginning on another worker.
  for (const { renew } of active.values()) clearInterval(renew);
  log("stopped", { inFlight: active.size });
}

void main();

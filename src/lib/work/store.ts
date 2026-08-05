import "server-only";
import { Prisma } from "@prisma/client";
import type { WorkRun, WorkSession } from "@prisma/client";
import { prisma, prismaUnguarded } from "@/lib/db";
import type { EventVisibility } from "@/lib/event-envelope";
import {
  NO_BUDGET,
  RUN_LEASE_MS,
  WORK_TERMINAL_STATUSES,
  defaultVisibilityFor,
  statusForTerminalReason,
  statusNeedsAttention,
  type WorkBudget,
  type WorkCapability,
  type WorkDegradation,
  type WorkEffectiveTarget,
  type WorkEventKind,
  type WorkPermissionPolicy,
  type WorkStatus,
  type WorkTarget,
  type WorkTerminalReason,
  type WorkTerminalStatus,
} from "@/lib/work/domain";

/**
 * The session and run lifecycle: create, append, claim, finish.
 *
 * Everything here is written so that two writers racing produces one outcome
 * rather than two half-outcomes. Work has more concurrent writers than any
 * other surface in Juno — a cloud executor, one or more Macs, a scheduler, and
 * the user's own phone and browser — and every function below is shaped by
 * which pair of them can collide.
 *
 * Every query carries `userId`, including the ones whose primary key would be
 * enough on its own. The ownership guard in `src/lib/db.ts` throws in
 * development when it does not, and the guard is the reason a mistake here is
 * caught by whoever writes it rather than by whoever reads someone else's
 * session.
 */

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface CreateWorkSessionInput {
  userId: string;
  /**
   * A caller-chosen primary key, for idempotent creation.
   *
   * WorkSession has no idempotencyKey column, so its primary key is the only
   * uniqueness constraint a retry can collide on. A caller that derives the id
   * from the user and its own key — see idempotentSessionId in the sessions
   * route — turns a retried tap on a flaky connection into a P2002 it can
   * recover from, instead of a second session. Omit it and a cuid is allocated
   * as before.
   */
  id?: string;
  title: string;
  /** What the user actually asked for, verbatim. Plans are checked against it. */
  goal: string;
  titleSource?: string;
  projectId?: string | null;
  /** The chat this was started from, when it was one. */
  conversationId?: string | null;
  requestedTarget?: WorkTarget;
  preferredHostId?: string | null;
  requestedModel?: string | null;
  reasoningEffort?: string | null;
  /** The session's requested policy. Runs intersect it with host and project. */
  permissionPolicy?: WorkPermissionPolicy;
}

/**
 * Creates a session in `draft`.
 *
 * Draft, not queued: composing a session costs nothing and holds no executor,
 * and a session that reaches `queued` the instant it is created cannot be
 * edited before it runs — which is the state a user is in for the whole time
 * they are still writing the goal.
 */
export async function createWorkSession(input: CreateWorkSessionInput): Promise<WorkSession> {
  return prisma.workSession.create({
    data: {
      ...(input.id ? { id: input.id } : {}),
      userId: input.userId,
      title: input.title,
      titleSource: input.titleSource ?? "default",
      goal: input.goal,
      projectId: input.projectId ?? null,
      conversationId: input.conversationId ?? null,
      status: "draft",
      needsAttention: false,
      requestedTarget: input.requestedTarget ?? "automatic",
      preferredHostId: input.preferredHostId ?? null,
      requestedModel: input.requestedModel ?? null,
      reasoningEffort: input.reasoningEffort ?? null,
      permissionPolicy: input.permissionPolicy ?? "balanced",
    },
  });
}

export interface SetSessionAttentionInput {
  sessionId: string;
  userId: string;
  /** The current run's status, which the session mirrors. */
  status: WorkStatus;
  /**
   * Overrides the value derived from `status`. Only for the cases where the
   * status alone is not the whole story — a run still `running` on a Mac that
   * has just gone quiet, for instance.
   */
  needsAttention?: boolean;
  now?: Date;
}

/**
 * Keeps the session's denormalised `status`/`needsAttention` in step.
 *
 * Both columns exist so the list view does not join a run per row, and
 * `needsAttention` is stored rather than derived because deriving it meant
 * every client re-implemented the same three-way test and each got a different
 * third of it right. The run stays authoritative; this is the copy, and it is
 * only ever written through here so there is one place the copy can drift.
 */
export async function setSessionAttention(input: SetSessionAttentionInput): Promise<void> {
  await prisma.workSession.updateMany({
    where: { id: input.sessionId, userId: input.userId },
    data: {
      status: input.status,
      needsAttention: input.needsAttention ?? statusNeedsAttention(input.status),
      lastActivityAt: input.now ?? new Date(),
    },
  });
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface CreateRunInput {
  sessionId: string;
  userId: string;
  /**
   * Why this run exists: manual | retry | schedule | trigger | resume | fork.
   * A plain string because `domain.ts` does not own this vocabulary, and a
   * second copy of a union is a second copy that goes stale.
   */
  origin?: string;
  scheduleId?: string | null;
  requestedTarget: WorkTarget;
  effectiveTarget?: WorkEffectiveTarget | null;
  hostId?: string | null;
  requestedModel?: string | null;
  effectiveModel?: string | null;
  requiredCapabilities?: readonly WorkCapability[];
  availableCapabilities?: readonly WorkCapability[];
  degradation?: readonly WorkDegradation[];
  /** The resolved policy, after narrowing by host, project, schedule, session. */
  permissionPolicy?: Prisma.InputJsonValue;
  budget?: WorkBudget;
  /** A schedule firing twice resolves to the same run rather than a second one. */
  idempotencyKey?: string | null;
}

export interface CreateRunResult {
  run: WorkRun;
  /** True when the idempotency key matched a run that already existed. */
  replay: boolean;
}

/**
 * How many times to re-derive `attempt` when another writer takes the number
 * first. Two clients retrying a dispatch at once is the realistic case, and it
 * settles in one extra pass; anything beyond that is a bug worth surfacing
 * rather than a race worth looping on.
 */
const ATTEMPT_ALLOCATION_TRIES = 4;

/**
 * Starts a new attempt at a session.
 *
 * `attempt` is allocated by reading the session's highest and adding one, which
 * is a read-then-write and therefore racy — so the loop below treats a
 * `(sessionId, attempt)` unique violation as "somebody else took that number"
 * and derives a fresh one. The alternative, a counter column on the session,
 * would serialise every run creation for that session behind one row lock and
 * would still need this loop for the retry case.
 *
 * `attempt` is worth that trouble because it is what a user means by "the
 * second try". Run ids are opaque and a timestamp is not an ordinal.
 */
export async function createRun(input: CreateRunInput): Promise<CreateRunResult> {
  const idempotencyKey = input.idempotencyKey ?? null;
  if (idempotencyKey) {
    const existing = await prisma.workRun.findFirst({
      where: { userId: input.userId, idempotencyKey },
    });
    if (existing) return { run: existing, replay: true };
  }

  const budget = input.budget ?? NO_BUDGET;
  // Rebuilt as object literals rather than passed through, so the arrays land
  // in JSONB in the shape `domain.ts` describes and an optional `subject` that
  // is absent stays absent instead of becoming a `null` the reader must handle.
  const degradation: Prisma.InputJsonValue = (input.degradation ?? []).map((entry) =>
    entry.subject === undefined
      ? { kind: entry.kind, explanation: entry.explanation }
      : { kind: entry.kind, explanation: entry.explanation, subject: entry.subject }
  );

  for (let tries = 0; tries < ATTEMPT_ALLOCATION_TRIES; tries++) {
    try {
      const run = await prisma.$transaction(async (tx) => {
        const latest = await tx.workRun.findFirst({
          where: { sessionId: input.sessionId, userId: input.userId },
          orderBy: { attempt: "desc" },
          select: { attempt: true },
        });
        const created = await tx.workRun.create({
          data: {
            sessionId: input.sessionId,
            userId: input.userId,
            attempt: (latest?.attempt ?? 0) + 1,
            origin: input.origin ?? "manual",
            scheduleId: input.scheduleId ?? null,
            status: "queued",
            requestedTarget: input.requestedTarget,
            effectiveTarget: input.effectiveTarget ?? null,
            hostId: input.hostId ?? null,
            requestedModel: input.requestedModel ?? null,
            effectiveModel: input.effectiveModel ?? null,
            requiredCapabilities: [...(input.requiredCapabilities ?? [])],
            availableCapabilities: [...(input.availableCapabilities ?? [])],
            degradation,
            permissionPolicy: input.permissionPolicy ?? {},
            maxCostMicroUsd: budget.maxCostMicroUsd,
            maxTokens: budget.maxTokens,
            maxRuntimeMs: budget.maxRuntimeMs,
            idempotencyKey,
          },
        });
        // Queueing a run is what makes the session live again, and it clears
        // `needsAttention`: whatever the user was being asked about, they have
        // now answered it by starting another attempt.
        await tx.workSession.updateMany({
          where: { id: input.sessionId, userId: input.userId },
          data: { status: "queued", needsAttention: false, lastActivityAt: new Date() },
        });
        return created;
      });
      return { run, replay: false };
    } catch (err) {
      const conflict = uniqueConflict(err);
      if (!conflict) throw err;
      if (idempotencyKey && conflict.some((column) => column.includes("idempotencyKey"))) {
        // Two dispatches of the same key raced past the pre-check above. The
        // loser reads the winner rather than reporting a conflict, because from
        // the caller's point of view the run it asked for now exists.
        const winner = await prisma.workRun.findFirst({
          where: { userId: input.userId, idempotencyKey },
        });
        if (winner) return { run: winner, replay: true };
        throw err;
      }
      if (!conflict.some((column) => column.includes("attempt"))) throw err;
    }
  }

  throw new Error(
    `createRun: could not allocate an attempt number for session ${input.sessionId} after ${ATTEMPT_ALLOCATION_TRIES} tries`
  );
}

/** The columns a P2002 names, or null when the error is not a unique violation. */
function uniqueConflict(err: unknown): string[] | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") return null;
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  if (Array.isArray(target)) return target.filter((entry): entry is string => typeof entry === "string");
  return typeof target === "string" ? [target] : [];
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface WorkEventInput {
  kind: WorkEventKind;
  payload: Prisma.InputJsonValue;
  /** The producer's idempotency key. See `WorkEvent.eventKey`. */
  key?: string | null;
  payloadVersion?: number;
  /** Defaults to the per-kind table in `domain.ts`, which is the right default. */
  visibility?: EventVisibility;
  /** Set when a subagent, not the root agent, emitted this. */
  agentId?: string | null;
}

export interface AppendedWorkEvent {
  seq: number;
  kind: WorkEventKind;
  payloadVersion: number;
  visibility: EventVisibility;
  payload: Prisma.InputJsonValue;
  eventKey: string | null;
  agentId: string | null;
}

export interface AppendEventsResult {
  /** The run's sequence after the append — the cursor a client resumes from. */
  lastSeq: number;
  /** What was actually written, in order, with the seq each was given. */
  appended: AppendedWorkEvent[];
  /** How many inputs were dropped because the run had already stored them. */
  duplicates: number;
}

export interface AppendEventsInput {
  runId: string;
  userId: string;
  events: readonly WorkEventInput[];
}

/**
 * Appends a batch of events, idempotently, allocating `seq` atomically.
 *
 * The dedupe by `eventKey` happens BEFORE `lastSeq` is incremented, and the
 * order is the whole trick. An executor retries a batch whose POST committed
 * but whose response was lost; if the duplicates were left in and arbitrated by
 * the unique index instead — `createMany({ skipDuplicates: true })` — `lastSeq`
 * would already have been incremented for the rows that were then skipped, and
 * the sequence would carry a permanent hole. The SSE cursor cannot tell a hole
 * from an event that has not arrived yet, so it waits for one that is never
 * coming, and the transcript stops updating for good.
 *
 * All of it in one transaction, because the increment and the inserts are the
 * same fact: a reader that saw the new `lastSeq` and then queried the events
 * would otherwise find the run claiming events it cannot yet see.
 */
export async function appendEvents(input: AppendEventsInput): Promise<AppendEventsResult> {
  return prisma.$transaction(async (tx) => {
    const keyed = input.events.filter(
      (event): event is WorkEventInput & { key: string } =>
        typeof event.key === "string" && event.key.length > 0
    );
    let deliverable = input.events;
    if (keyed.length > 0) {
      const seen = await tx.workEvent.findMany({
        where: {
          runId: input.runId,
          userId: input.userId,
          eventKey: { in: keyed.map((event) => event.key) },
        },
        select: { eventKey: true },
      });
      if (seen.length > 0) {
        const already = new Set(seen.map((row) => row.eventKey));
        deliverable = input.events.filter((event) => !event.key || !already.has(event.key));
      }
    }

    // The update is what serialises concurrent appends: it takes the run's row
    // lock, so a second batch arriving mid-transaction waits and then reads a
    // `lastSeq` that already includes this one's events.
    const run = await tx.workRun.update({
      where: { id: input.runId, userId: input.userId },
      data: { lastSeq: { increment: deliverable.length } },
      select: { lastSeq: true, sessionId: true },
    });

    const firstSeq = run.lastSeq - deliverable.length + 1;
    const appended: AppendedWorkEvent[] = deliverable.map((event, index) => ({
      seq: firstSeq + index,
      kind: event.kind,
      payloadVersion: event.payloadVersion ?? 1,
      visibility: event.visibility ?? defaultVisibilityFor(event.kind),
      payload: event.payload,
      eventKey: event.key ?? null,
      agentId: event.agentId ?? null,
    }));

    if (appended.length > 0) {
      await tx.workEvent.createMany({
        data: appended.map((event) => ({ runId: input.runId, userId: input.userId, ...event })),
      });
      await tx.workSession.updateMany({
        where: { id: run.sessionId, userId: input.userId },
        data: { lastActivityAt: new Date() },
      });
    }

    return { lastSeq: run.lastSeq, appended, duplicates: input.events.length - deliverable.length };
  });
}

// ---------------------------------------------------------------------------
// Leases
// ---------------------------------------------------------------------------

export interface ClaimRunInput {
  runId: string;
  userId: string;
  /** Stable identity of the executor taking the lease, recorded on the run. */
  executorId: string;
  leaseMs?: number;
  now?: Date;
}

export type ClaimRunResult =
  | { claimed: true; run: WorkRun }
  /** `run` is the current row, so a caller that lost can see who holds it. */
  | { claimed: false; run: WorkRun | null };

/**
 * Takes the lease on a queued run, or reports that somebody else has it.
 *
 * The check and the write are one statement on purpose. Reading the run,
 * seeing `queued`, and then writing the claim leaves a window in which a second
 * executor does the same, and both come away believing they own the run: two
 * sandboxes, two sets of file writes, one user watching the same step happen
 * twice. Putting the condition in the `updateMany` WHERE makes Postgres
 * re-evaluate it against the committed row, so exactly one caller sees a count
 * of 1 and every other sees 0.
 *
 * A lease with an expiry rather than a boolean flag, because an executor that
 * dies mid-run is the common case and a boolean strands its run in `running`
 * for ever with nobody able to take it.
 */
export async function claimRun(input: ClaimRunInput): Promise<ClaimRunResult> {
  const now = input.now ?? new Date();
  const claimed = await prisma.workRun.updateMany({
    where: {
      id: input.runId,
      userId: input.userId,
      status: "queued",
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
    },
    data: {
      status: "preparing",
      claimedBy: input.executorId,
      claimedAt: now,
      leaseExpiresAt: new Date(now.getTime() + (input.leaseMs ?? RUN_LEASE_MS)),
      // The runtime budget is measured from here, which is the moment the run
      // starts costing something rather than the moment the model first speaks.
      startedAt: now,
    },
  });

  const run = await prisma.workRun.findFirst({ where: { id: input.runId, userId: input.userId } });
  if (claimed.count === 0 || !run) return { claimed: false, run };

  await setSessionAttention({
    sessionId: run.sessionId,
    userId: input.userId,
    status: "preparing",
    now,
  });
  return { claimed: true, run };
}

// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------

/** Terminal detail is operator-facing prose, not a place to store a transcript. */
const MAX_TERMINAL_DETAIL_CHARS = 4_000;

export interface FinishRunInput {
  runId: string;
  userId: string;
  reason: WorkTerminalReason;
  /** Operator-facing detail behind the reason. Never the model's text. */
  detail?: string | null;
  now?: Date;
}

export type FinishRunResult =
  | { finished: true; run: WorkRun; status: WorkTerminalStatus }
  /** Already terminal, or gone. `run` carries whatever the row says now. */
  | { finished: false; run: WorkRun | null };

/**
 * Ends a run once, and only once.
 *
 * The WHERE excludes every terminal status, which is what makes
 * `terminalReason` a write-once column without a second mechanism: the first
 * writer to commit moves the run out of the live set, and every later writer
 * matches zero rows. That matters because late writers are normal here, not
 * exceptional — a host reconnecting with a queued `stop`, a budget sweeper and
 * the executor's own failure path can all arrive within a second of each
 * other, and without the guard the last one to land would rewrite why the run
 * ended, or worse, drag a finished run back into `running`.
 *
 * The session's copy of the status is only updated when no later attempt
 * exists. A superseded run finishing after its replacement started would
 * otherwise stamp `cancelled` over a session that is busy running.
 */
export async function finishRun(input: FinishRunInput): Promise<FinishRunResult> {
  const now = input.now ?? new Date();
  const status = statusForTerminalReason(input.reason);

  return prisma.$transaction(async (tx): Promise<FinishRunResult> => {
    const moved = await tx.workRun.updateMany({
      where: {
        id: input.runId,
        userId: input.userId,
        status: { notIn: [...WORK_TERMINAL_STATUSES] },
      },
      data: {
        status,
        terminalReason: input.reason,
        terminalDetail: input.detail ? input.detail.slice(0, MAX_TERMINAL_DETAIL_CHARS) : null,
        finishedAt: now,
        // Released so a sweeper looking for abandoned leases does not find this
        // one and go looking for an executor that has already gone home.
        leaseExpiresAt: null,
      },
    });

    const run = await tx.workRun.findFirst({ where: { id: input.runId, userId: input.userId } });
    if (moved.count === 0 || !run) return { finished: false, run };

    const newer = await tx.workRun.findFirst({
      where: { sessionId: run.sessionId, userId: input.userId, attempt: { gt: run.attempt } },
      select: { id: true },
    });
    if (!newer) {
      await tx.workSession.updateMany({
        where: { id: run.sessionId, userId: input.userId },
        data: {
          status,
          // `host_offline` is terminal and still needs the user: the run is
          // over, but the decision to wake the Mac or move to cloud is theirs
          // and is never made if it is filed under "failed".
          needsAttention: statusNeedsAttention(status),
          lastActivityAt: now,
        },
      });
    }

    return { finished: true, run, status };
  });
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

export interface ReclaimStalledRunsInput {
  /** Scope to one account, or omit to sweep every account. */
  userId?: string;
  now?: Date;
  /** Safety cap so one sweep cannot rewrite an unbounded number of rows. */
  limit?: number;
}

export interface ReclaimStalledRunsResult {
  /** Run ids moved to `interrupted`. */
  reclaimed: string[];
}

/**
 * Ends runs whose executor stopped renewing its lease.
 *
 * `claimRun` only ever takes a `queued` run, which is correct — a run already
 * in flight must not be picked up by a second executor and replayed. The
 * consequence is that a run whose executor died mid-flight has nobody who can
 * take it and nobody who will finish it: it sits in `preparing` or `running`
 * for ever, and every surface renders it as a task that is still going. That is
 * exactly the endless spinner the whole target-selection design exists to
 * avoid, arriving one layer further down.
 *
 * So the lease is swept rather than merely checked. An expired lease on a live
 * run means the executor is gone, and the honest terminal state is
 * `interrupted` — distinct from `failed`, which the run itself decided, and
 * from `cancelled`, which a person decided. Nobody decided this one.
 *
 * Deliberately does NOT re-queue. A Work run can have moved files, sent a
 * message, or spent most of a budget before its executor died, and restarting
 * it automatically would repeat whichever of those had already happened. The
 * user is told it was interrupted and offered a retry, which is a decision with
 * an owner.
 *
 * Uses `prismaUnguarded` when sweeping every account, because the ownership
 * guard is there to catch a query that forgot its userId and this one omits it
 * on purpose.
 */
export async function reclaimStalledRuns(
  input: ReclaimStalledRunsInput = {}
): Promise<ReclaimStalledRunsResult> {
  const now = input.now ?? new Date();
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 1_000);

  const where: Prisma.WorkRunWhereInput = {
    status: { in: ["preparing", "running"] },
    leaseExpiresAt: { lt: now },
    ...(input.userId ? { userId: input.userId } : {}),
  };

  // Scoped sweeps stay guarded; the cross-account one says out loud that it is
  // global rather than tripping a guard whose whole job is to notice that.
  const client = input.userId ? prisma : prismaUnguarded;
  const stalled = await client.workRun.findMany({
    where,
    select: { id: true, userId: true },
    orderBy: { leaseExpiresAt: "asc" },
    take: limit,
  });

  const reclaimed: string[] = [];
  for (const run of stalled) {
    // Through finishRun rather than a bulk update, so a reclaimed run gets the
    // same write-once terminal guard, the same session denormalisation and the
    // same needs-attention handling as one that ended normally. A bulk update
    // here would be the second place terminal state is decided, and the two
    // would drift.
    const result = await finishRun({
      runId: run.id,
      userId: run.userId,
      reason: "interrupted",
      detail:
        "The executor stopped reporting and its lease expired. Juno does not " +
        "restart an interrupted run on its own, because it may already have " +
        "changed something.",
      now,
    });
    if (result.finished) reclaimed.push(run.id);
  }

  return { reclaimed };
}

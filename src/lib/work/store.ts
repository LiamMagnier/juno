import "server-only";
import { Prisma } from "@prisma/client";
import type { WorkCommand, WorkRun, WorkSession } from "@prisma/client";
import { prisma, prismaUnguarded } from "@/lib/db";
import type { EventVisibility } from "@/lib/event-envelope";
import {
  CHECKPOINT_RETENTION_MS,
  DEFAULT_WORK_PERMISSION_POLICY,
  NO_BUDGET,
  RUN_LEASE_MS,
  WORK_TERMINAL_STATUSES,
  defaultVisibilityFor,
  isResumableTerminalReason,
  statusForTerminalReason,
  statusNeedsAttention,
  type WorkBudget,
  type WorkCapability,
  type WorkCommandKind,
  type WorkDegradation,
  type WorkEffectiveTarget,
  type WorkEventKind,
  type WorkPermissionPolicy,
  type WorkStatus,
  type WorkTarget,
  type WorkTerminalReason,
  type WorkTerminalStatus,
} from "@/lib/work/domain";
import {
  commandExpiresAt,
  planRunCommand,
  runCommandKey,
  type WorkRelayRefusal,
} from "@/lib/work/relay";

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
  /**
   * How much thinking the reader asked for: `minimal` … `max`, or null for
   * Instant.
   *
   * This docstring used to say the column was read by nothing, and that has
   * stopped being true — it is corrected here rather than deleted, because the
   * next person to wonder whether the control does anything deserves the answer
   * and not a silence. `scripts/work-runner.ts` reads
   * `run.session.reasoningEffort` through `reasoningEffortFor` when it builds
   * the loop, and `WorkSessionOptions.reasoningEffort` now carries it into
   * `ProviderRequest`.
   *
   * Two narrowings still stand between this column and the request, and both
   * matter to anything that reports on the field: a provider whose adapter does
   * not speak the parameter drops it, and `clampReasoningEffort` bounds the tier
   * to what the chosen model actually accepts. So a value here is a request, not
   * a guarantee — and it is read once, when the attempt starts, which is why
   * `PATCH /api/work/sessions/[id]/context` reports a change to it as taking
   * effect from the next attempt rather than immediately.
   */
  reasoningEffort?: string | null;
  /** The session's requested policy. Runs intersect it with host and project. */
  permissionPolicy?: WorkPermissionPolicy;
  /**
   * The files this session starts life with, granted alongside it.
   *
   * Ownership must already have been re-checked against the user — see the
   * grant shape below for why this function will not do it for you.
   */
  attachments?: readonly SessionAttachmentGrant[];
}

/**
 * Creates a session in `draft`, with its file grants, in one transaction.
 *
 * Draft, not queued: composing a session costs nothing and holds no executor,
 * and a session that reaches `queued` the instant it is created cannot be
 * edited before it runs — which is the state a user is in for the whole time
 * they are still writing the goal.
 *
 * The grants are in the transaction rather than in a second statement after it,
 * and that is the whole reason this function opens one. The two writes used to
 * be sequential and independent: a transient failure on the second left a
 * session that existed, was returned to the composer as created, and had none
 * of the reader's files attached to it. The retry made it worse rather than
 * better — a retry carries the same idempotency key, so it landed on the replay
 * path, which returned the session that already existed and never wrote the
 * grants at all. The attachment was gone for good, the reader was told the task
 * was saved, and the only visible symptom was an agent that behaved as though
 * the spreadsheet it was asked to reconcile had never been mentioned.
 */
export async function createWorkSession(input: CreateWorkSessionInput): Promise<WorkSession> {
  return prisma.$transaction(async (tx) => {
    const session = await tx.workSession.create({
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
        // `DEFAULT_WORK_PERMISSION_POLICY` rather than the literal it used to
        // be. Same value, but the reason for it — Manual asks so often that its
        // owner learns to press Allow without reading — is now written down
        // once, in domain.ts, next to the ladder that gives the three modes
        // their meaning.
        permissionPolicy: input.permissionPolicy ?? DEFAULT_WORK_PERMISSION_POLICY,
      },
    });

    const attachments = input.attachments ?? [];
    if (attachments.length > 0) {
      await tx.workFileGrant.createMany({
        data: attachmentGrantRows(input.userId, session.id, attachments),
      });
    }
    return session;
  });
}

export interface SetSessionAttentionInput {
  sessionId: string;
  userId: string;
  /** Optional lease fence for executor-owned mirrors. */
  runId?: string;
  executorId?: string;
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
    where: {
      id: input.sessionId,
      userId: input.userId,
      ...(input.runId && input.executorId
        ? { runs: { some: { id: input.runId, claimedBy: input.executorId } } }
        : {}),
    },
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
  /**
   * The instruction that drives this run on a Mac, written in the same
   * transaction as the run itself.
   *
   * Omitted for a cloud run, which has no host to instruct — the cloud executor
   * finds its work by polling for `queued` runs. Present for a local one, and
   * present *here* rather than in a second statement after the dispatch,
   * because the two writes are one fact. Sequentially, either half can be the
   * one that lands: a run with no command is a task the Mac is never told about
   * and the user watches spin until its lease is swept, and a command with no
   * run is an instruction naming a row that does not exist, which the Mac
   * claims and fails.
   *
   * It carries no idempotency key. The only key that makes a `start` exactly
   * once is derived from the run id, and the run id does not exist until the
   * statement above this one has run.
   */
  command?: RunDrivingCommand;
}

/** The instruction `createRun` writes alongside the run it drives. */
export interface RunDrivingCommand {
  hostId: string;
  kind: WorkCommandKind;
  payload: Record<string, unknown>;
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
        // Read once per attempt rather than per statement, so the command's TTL
        // is measured from the moment the run was made and not from whenever
        // the insert after it happened to execute.
        const now = new Date();
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

        if (input.command) {
          await tx.workCommand.create({
            data: {
              userId: input.userId,
              hostId: input.command.hostId,
              sessionId: input.sessionId,
              runId: created.id,
              kind: input.command.kind,
              payload: input.command.payload as Prisma.InputJsonObject,
              // Derived from the run this transaction just made, which is what
              // makes it exactly-once without a second mechanism: a retried
              // dispatch carrying the same run idempotency key never reaches
              // here at all — it is answered from the existing run above — and
              // an attempt-number collision rolls this insert back with it.
              idempotencyKey: runCommandKey(created.id, input.command.kind),
              expiresAt: commandExpiresAt(now),
            },
          });
        }

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
// Commands
// ---------------------------------------------------------------------------

export interface DispatchRunCommandInput {
  userId: string;
  sessionId: string;
  /** Null only for a command about a session rather than one of its runs. */
  runId: string | null;
  /** The run's own `hostId`, which is the only Mac allowed to be told. */
  hostId: string | null;
  /** The run's `effectiveTarget`. Anything but `local` has no Mac to tell. */
  effectiveTarget: string | null;
  kind: WorkCommandKind;
  payload?: Record<string, unknown>;
  /** Derived, never random. See `runCommandKey`. */
  idempotencyKey: string;
  now?: Date;
}

export type DispatchRunCommandResult =
  | { status: "queued"; command: WorkCommand }
  /** Nothing to send and nothing wrong: this run is not on a Mac. */
  | { status: "skipped"; why: "not_local" | "no_host" }
  /** The Mac is revoked, switched off, or too old to parse this instruction. */
  | { status: "refused"; refusal: WorkRelayRefusal };

/**
 * Tells the Mac executing a run what its owner just decided.
 *
 * Every control surface needs this and none of them should be reimplementing
 * it: pause, resume, cancel, an answer and an approval decision are all a row
 * moving on this side and an instruction that has to reach the machine actually
 * doing the work. Until this existed they were only the first half, so a pause
 * pressed on a phone marked the run paused in Postgres while the Mac carried on
 * moving files.
 *
 * The host is re-read here rather than taken from the caller, and it is read
 * scoped to the account. A run's `hostId` is a column that was written at
 * dispatch and the Mac behind it can have been revoked since; asking now is
 * what makes revocation take effect on the next instruction rather than at the
 * next registration.
 *
 * Upserted with `update: {}`, the same contract as
 * `POST /api/work/hosts/[id]/commands`: the key names one logical instruction,
 * and a retry must resolve to the command that already exists rather than
 * rewrite one the Mac may already have claimed and be executing.
 *
 * Deliberately NOT the writer of any run state. A cancel still goes through
 * `finishRun`, an approval is still recorded by its own route; this only ever
 * adds the instruction that makes the Mac agree with what they wrote.
 */
export async function dispatchRunCommand(
  input: DispatchRunCommandInput
): Promise<DispatchRunCommandResult> {
  const host = input.hostId
    ? await prisma.workHost.findFirst({
        where: { id: input.hostId, userId: input.userId },
        select: { id: true, enabled: true, revokedAt: true, protocolVersion: true },
      })
    : null;

  const plan = planRunCommand({
    effectiveTarget: input.effectiveTarget,
    host,
    kind: input.kind,
  });
  if (plan.plan === "skip") return { status: "skipped", why: plan.why };
  if (plan.plan === "refuse") return { status: "refused", refusal: plan.refusal };

  const now = input.now ?? new Date();
  const command = await prisma.workCommand.upsert({
    where: { userId_idempotencyKey: { userId: input.userId, idempotencyKey: input.idempotencyKey } },
    create: {
      userId: input.userId,
      hostId: plan.hostId,
      sessionId: input.sessionId,
      runId: input.runId,
      kind: input.kind,
      payload: (input.payload ?? {}) as Prisma.InputJsonObject,
      idempotencyKey: input.idempotencyKey,
      expiresAt: commandExpiresAt(now),
    },
    update: {},
  });

  return { status: "queued", command };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export interface SessionAttachmentGrant {
  /** The `Attachment` row's id. Ownership must already have been re-checked. */
  attachmentId: string;
  /** The name the reader uploaded it under. Shown to them, and to the agent. */
  fileName: string;
}

/**
 * The `kind` an attached upload is granted under.
 *
 * Named rather than repeated, because it is also the filter the reconcile below
 * sweeps with: the two have to be the same string or a reconcile would revoke
 * grants it did not write.
 */
const ATTACHMENT_GRANT_KIND = "cloud_file";

/**
 * The `WorkFileGrant` rows a set of attachments becomes.
 *
 * These are the first `WorkFileGrant` rows anything in the tree writes, and the
 * shape is a decision rather than a formality. A cloud attachment is
 * `kind: "cloud_file"` with the attachment id in `remoteRef` — the column the
 * schema describes as "stable identity for a cloud source" — and `localPath`
 * stays null, because there is no path: the file lives in the bucket, and a
 * grant that invented a path for it would be a grant `serializeGrantForRemote`
 * has to redact and a host could try to resolve.
 *
 * `read`, never `read_write`. Attaching a file to a task is a statement about
 * what the agent may look at, not permission to edit the reader's library in
 * place. A run that produces a changed version of an attached workbook writes
 * a new artifact, which the reader can compare against the original — an
 * in-place write leaves them nothing to compare it against.
 *
 * Scoped to the session (`sessionId` set, `hostId` null) rather than
 * account-wide. An account-wide grant would make a spreadsheet attached to one
 * task readable by every later task in the account, which is not what dropping
 * a file into a composer means.
 *
 * A pure row builder, taking no client, so the two callers that write these —
 * `createWorkSession` inside its transaction and `reconcileSessionAttachments`
 * inside its own — share the shape without either of them owning it. Neither
 * re-checks that the attachment ids belong to the user: the route does that
 * before it builds a `SessionAttachmentGrant`, and a store function that took
 * raw ids and checked them itself would make the check look optional at the
 * call site where it is not.
 */
function attachmentGrantRows(
  userId: string,
  sessionId: string,
  attachments: readonly SessionAttachmentGrant[]
): Prisma.WorkFileGrantCreateManyInput[] {
  return attachments.map((attachment) => ({
    userId,
    sessionId,
    hostId: null,
    kind: ATTACHMENT_GRANT_KIND,
    displayName: attachment.fileName,
    localPath: null,
    remoteRef: attachment.attachmentId,
    accessMode: "read",
  }));
}

export interface ReconcileSessionAttachmentsInput {
  userId: string;
  sessionId: string;
  /**
   * The whole set the client last sent, not a delta. An empty array is a
   * reader who has removed every file, and is honoured as such.
   */
  attachments: readonly SessionAttachmentGrant[];
  now?: Date;
}

export interface ReconcileSessionAttachmentsResult {
  granted: number;
  revoked: number;
}

/**
 * Brings a session's attachment grants in line with what the client last sent.
 *
 * A grant used to be write-once: the create route granted on the path that
 * created the session and never anywhere else. That is defensible right up
 * until the composer reuses a draft, which it does whenever the goal has not
 * changed — so a reader who attached the wrong spreadsheet, removed it, and
 * pressed the button again got a session whose grant list still held the file
 * they had taken out of the UI. It was mirrored onto the run's input manifest
 * at dispatch and read out to the model, and nothing on any surface said so.
 *
 * Reconciled rather than appended, because appending cannot express a removal
 * and a set that only grows is not a set the reader is editing.
 *
 * Revoked, never deleted. `revokedAt` is what makes the history readable — a
 * grant that was held and withdrawn is a different answer to "what was this
 * agent allowed to read" than a grant that never existed, and it is the second
 * question an incident asks. For the same reason a file that is removed and
 * then re-added becomes a second row rather than a cleared `revokedAt`: the
 * history should read granted, revoked, granted again, which is what happened.
 *
 * Scoped to `ATTACHMENT_GRANT_KIND`. A session can carry grants this route
 * never wrote — a folder on a Mac, a connector scope — and a composer that has
 * never heard of them must not revoke them by failing to mention them.
 */
export async function reconcileSessionAttachments(
  input: ReconcileSessionAttachmentsInput
): Promise<ReconcileSessionAttachmentsResult> {
  const now = input.now ?? new Date();

  // One transaction so the revokes and the grants are one edit. A reader who
  // swapped one file for another and saw only the revoke commit would have a
  // session with neither file and no way to tell that from having attached
  // nothing.
  return prisma.$transaction(async (tx) => {
    const live = await tx.workFileGrant.findMany({
      where: {
        userId: input.userId,
        sessionId: input.sessionId,
        kind: ATTACHMENT_GRANT_KIND,
        revokedAt: null,
      },
      select: { id: true, remoteRef: true },
    });

    const wanted = new Set(input.attachments.map((attachment) => attachment.attachmentId));
    // A live attachment grant with no `remoteRef` names no file, so nothing can
    // ever ask for it again; it is swept with the rest rather than left behind
    // as a row the reconcile can never converge on.
    const stale = live.filter((grant) => grant.remoteRef === null || !wanted.has(grant.remoteRef));
    const held = new Set(
      live.map((grant) => grant.remoteRef).filter((ref): ref is string => ref !== null)
    );
    const missing = input.attachments.filter((attachment) => !held.has(attachment.attachmentId));

    let revoked = 0;
    if (stale.length > 0) {
      const swept = await tx.workFileGrant.updateMany({
        where: { id: { in: stale.map((grant) => grant.id) }, userId: input.userId, revokedAt: null },
        data: { revokedAt: now },
      });
      revoked = swept.count;
    }

    let granted = 0;
    if (missing.length > 0) {
      const created = await tx.workFileGrant.createMany({
        data: attachmentGrantRows(input.userId, input.sessionId, missing),
      });
      granted = created.count;
    }

    return { granted, revoked };
  });
}

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

export interface ReconcileSessionConnectorsInput {
  userId: string;
  sessionId: string;
  /**
   * The whole set the client last sent, not a delta. An empty array is a reader
   * who switched every app off, and is honoured as such — see `connectorsChosen`.
   */
  connectorIds: readonly string[];
}

export interface ReconcileSessionConnectorsResult {
  /** Apps this call handed to the task. A widening; it binds at the next dispatch. */
  added: number;
  /** Apps this call took away. A narrowing; it binds the moment this commits. */
  removed: number;
}

/**
 * Brings a session's connector grants in line with what the client last sent.
 *
 * Ownership of the ids must already have been re-checked against the account:
 * a provider id in a request body is a claim that the account has linked that
 * app, and the only thing that makes it true is a `Connection` row carrying the
 * user's id. Not done here, for the same reason `attachmentGrantRows` does not
 * do it — a store function that checked its own ids would make the check look
 * optional at the call site where it is not.
 *
 * The twin of `reconcileSessionAttachments`, deliberately shaped the same way
 * and living beside it: both answer "the reader edited a set of permissions on
 * an existing task", and a second module for the second set is how the two come
 * to disagree about what an empty array means.
 *
 * `connectorsChosen` is written in the same transaction as the rows, because the
 * two are one fact. The flag alone says a reader answered; the rows alone say
 * what they answered; a session carrying one without the other is read by
 * `WorkConnectorAllowlist.taskAllowed` in ./connectors as a task that may reach
 * everything the account can — the one outcome a reader who switched everything
 * off did not ask for.
 *
 * Deleted rather than revoked, which is the one place this differs from the
 * attachment reconcile, and it is a property of the table rather than a
 * decision made twice: `WorkSessionConnector` has no `revokedAt` and a unique
 * index on (sessionId, connectorId), so a re-added app has to be able to become
 * the same row again. The history question — which apps a run could actually
 * reach — is answered by the run's `WorkRunIO` rows and by the `policy_narrowed`
 * audit rows `evaluateConnector` writes, both of which outlive this table.
 *
 * The counts come from the database rather than from set arithmetic on the
 * input, so a row another writer removed in between is not reported to the
 * reader as something this request took away.
 *
 * NOTE for whoever touches this next: `writeSessionConnectors` in
 * src/app/api/work/sessions/route.ts does the same three writes inline for the
 * create path. It predates this function and should be moved onto it; it was
 * left alone here only because that route was outside the change that added
 * this one.
 */
export async function reconcileSessionConnectors(
  input: ReconcileSessionConnectorsInput
): Promise<ReconcileSessionConnectorsResult> {
  const wanted = [...new Set(input.connectorIds)];

  return prisma.$transaction(async (tx) => {
    const live = await tx.workSessionConnector.findMany({
      where: { sessionId: input.sessionId, userId: input.userId },
      select: { connectorId: true },
    });
    const held = new Set(live.map((row) => row.connectorId));
    const stale = live.filter((row) => !wanted.includes(row.connectorId));
    const missing = wanted.filter((connectorId) => !held.has(connectorId));

    if (stale.length > 0) {
      await tx.workSessionConnector.deleteMany({
        where: {
          sessionId: input.sessionId,
          userId: input.userId,
          connectorId: { in: stale.map((row) => row.connectorId) },
        },
      });
    }
    if (missing.length > 0) {
      // `skipDuplicates` because the unique index is the arbiter, not this read:
      // two saves racing must resolve to one row per app rather than to a 500.
      await tx.workSessionConnector.createMany({
        data: missing.map((connectorId) => ({
          sessionId: input.sessionId,
          userId: input.userId,
          connectorId,
        })),
        skipDuplicates: true,
      });
    }
    await tx.workSession.updateMany({
      where: { id: input.sessionId, userId: input.userId },
      data: { connectorsChosen: true },
    });

    return { added: missing.length, removed: stale.length };
  });
}

export interface RecordRunInputsInput {
  runId: string;
  sessionId: string;
  userId: string;
}

/**
 * Copies the session's live grants onto the run as its input manifest.
 *
 * A snapshot, taken at dispatch, and that is the point of the table: a grant
 * can be revoked the minute after a run starts, and a run whose inputs were
 * re-derived from the grant list afterwards would report a set of files that
 * is not the set it read. `WorkRunIO` answers "what went in", once, for ever.
 *
 * Only grants that name a cloud source are mirrored. `label` is documented in
 * the schema as "display label safe for any client. Never an absolute path.",
 * and a local grant's whole identity is its path — there is nothing else to put
 * in `refId` that a client could act on, and putting the path there would put
 * it on every phone that renders the run. The Mac resolves its own grants when
 * it claims the command, which is the only place a path is allowed to exist.
 *
 * Idempotent by intent rather than by constraint: called once per created run,
 * and skipped entirely on the replay path, because a replayed dispatch is the
 * same run and its manifest was written when the run was.
 */
export async function recordRunInputsFromGrants(input: RecordRunInputsInput): Promise<number> {
  const grants = await prisma.workFileGrant.findMany({
    where: { userId: input.userId, sessionId: input.sessionId, revokedAt: null },
    select: { remoteRef: true, displayName: true },
    orderBy: { createdAt: "asc" },
  });

  const rows = grants
    .filter((grant): grant is { remoteRef: string; displayName: string } => grant.remoteRef !== null)
    .map((grant) => ({
      runId: input.runId,
      direction: "input",
      refKind: "attachment",
      refId: grant.remoteRef,
      label: grant.displayName,
    }));
  if (rows.length === 0) return 0;

  const created = await prisma.workRunIO.createMany({ data: rows });
  return created.count;
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
    runId: run.id,
    executorId: input.executorId,
    status: "preparing",
    now,
  });
  return { claimed: true, run };
}

// ---------------------------------------------------------------------------
// Checkpoints and parking
// ---------------------------------------------------------------------------

/** Provider usage persisted on a Work attempt, in the database's integer units. */
export interface WorkRunUsage {
  costMicroUsd: number;
  inputTokens: number;
  outputTokens: number;
}

const MAX_PRISMA_INT = 2_147_483_647;

function usageData(usage: WorkRunUsage | undefined): Prisma.WorkRunUpdateManyMutationInput {
  if (!usage) return {};
  const integer = (value: number): number => {
    if (!Number.isFinite(value)) return 0;
    return Math.min(Math.max(Math.floor(value), 0), MAX_PRISMA_INT);
  };
  return {
    costMicroUsd: integer(usage.costMicroUsd),
    inputTokens: integer(usage.inputTokens),
    outputTokens: integer(usage.outputTokens),
  };
}

export interface SaveRunCheckpointInput {
  runId: string;
  userId: string;
  /** Only the executor holding the lease may advance the snapshot. */
  executorId: string;
  checkpoint: Prisma.InputJsonValue;
  /** The same snapshot's cumulative provider usage, when available. */
  usage?: WorkRunUsage;
}

/**
 * Stores the latest provider-neutral snapshot without allowing a stale worker
 * to overwrite a newer executor's state.
 *
 * A checkpoint is not a terminal result. It is written while the executor is
 * still alive and is therefore fenced by `claimedBy`; the conditional update
 * is the part that makes a late promise from an expired worker harmless.
 */
export async function saveRunCheckpoint(input: SaveRunCheckpointInput): Promise<boolean> {
  const saved = await prisma.workRun.updateMany({
    where: {
      id: input.runId,
      userId: input.userId,
      claimedBy: input.executorId,
      status: { in: ["preparing", "running", "waiting_input", "waiting_approval", "paused"] },
    },
    data: { checkpoint: input.checkpoint, ...usageData(input.usage) },
  });
  return saved.count === 1;
}

export interface ParkRunInput {
  runId: string;
  userId: string;
  /** The worker that produced the checkpoint and still owns the lease. */
  executorId: string;
  /** Cumulative usage at the pause boundary. */
  usage?: WorkRunUsage;
}

/**
 * Parks a paused run and releases its lease exactly once.
 *
 * The executor can reach this after the user has already pressed Resume. The
 * lease condition makes that late completion a no-op instead of dragging the
 * resumed, queued attempt back to `paused`.
 */
export async function parkRun(input: ParkRunInput): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const moved = await tx.workRun.updateMany({
      where: {
        id: input.runId,
        userId: input.userId,
        claimedBy: input.executorId,
        status: { in: ["preparing", "running", "waiting_input", "waiting_approval", "paused"] },
      },
      data: {
        status: "paused",
        ...usageData(input.usage),
        claimedBy: null,
        claimedAt: null,
        leaseExpiresAt: null,
      },
    });
    if (moved.count !== 1) return false;

    const run = await tx.workRun.findFirst({
      where: { id: input.runId, userId: input.userId },
      select: { sessionId: true },
    });
    if (run) {
      // Keep the denormalised session row in the same transaction as the
      // lease release. The status predicate matters: if Resume wins the race
      // after the run update, it changes the session to queued and this update
      // must not put it back into paused attention.
      await tx.workSession.updateMany({
        where: {
          id: run.sessionId,
          userId: input.userId,
          status: { in: ["preparing", "running", "waiting_input", "waiting_approval", "paused"] },
        },
        data: {
          status: "paused",
          needsAttention: true,
          lastActivityAt: new Date(),
        },
      });
    }
    return true;
  });
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
  /** Fences executor-owned terminal writes to the current lease holder. */
  executorId?: string;
  /** Cumulative provider usage at the terminal boundary. */
  usage?: WorkRunUsage;
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
        ...(input.executorId ? { claimedBy: input.executorId } : {}),
      },
      data: {
        status,
        terminalReason: input.reason,
        terminalDetail: input.detail ? input.detail.slice(0, MAX_TERMINAL_DETAIL_CHARS) : null,
        finishedAt: now,
        ...usageData(input.usage),
        // Kept only where picking the run up again is a thing somebody would
        // actually want — see `isResumableTerminalReason`, which carries the
        // argument. This column used to be nulled on every ending, which read as
        // tidiness and was in fact the reason resume did not exist: the restore
        // path in `WorkAgentSession` is complete and was unreachable from the one
        // ending it was written for. `sweepExpiredCheckpoints` bounds the
        // retention, so "not indefinitely" is still true.
        //
        // A paused run never reaches finishRun; it is parked explicitly above and
        // keeps its checkpoint regardless.
        ...(isResumableTerminalReason(input.reason) ? {} : { checkpoint: Prisma.JsonNull }),
        // Released so a sweeper looking for abandoned leases does not find this
        // one and go looking for an executor that has already gone home.
        claimedBy: null,
        claimedAt: null,
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

/**
 * The statuses an executor holds a lease on, and therefore the exact set a lease
 * sweep must cover.
 *
 * Written down once because it was written down twice and the two disagreed.
 * `startLeaseRenewal` in `scripts/work-runner.ts` renewed all four of these;
 * `reclaimStalledRuns` below swept only `preparing` and `running`. So a run
 * blocked on a question or an approval, whose executor then died, held a lease
 * nobody renewed and sat in a sweep nobody ran — permanently `waiting_input`,
 * rendered for ever as a task still waiting for an answer that would never do
 * anything. That is the endless spinner the sweep exists to prevent, reached
 * through the one door the sweep did not cover.
 *
 * `draft` and `queued` are absent because nothing holds them: a draft has no
 * executor and a queued run has not been claimed. `paused` is absent because a
 * paused run is parked deliberately and its lease is released.
 *
 * Here rather than in `domain.ts` on purpose. `domain.ts` is the vocabulary the
 * generated cross-language contract is built from, and `work-contract.test.ts`
 * asserts — correctly — that every list it exports is a vocabulary a client can
 * name. This is not one: no browser or Mac has any use for which statuses the
 * server leases, and publishing it would put an implementation detail of the
 * executor into a Swift enum.
 */
export const WORK_LEASED_STATUSES = [
  "preparing",
  "running",
  "waiting_input",
  "waiting_approval",
] as const satisfies readonly WorkStatus[];

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
    // Every status a lease is renewed on, from the one list that defines them.
    // This used to name `preparing` and `running` inline while the renewer kept
    // four alive — see `WORK_LEASED_STATUSES` for what that cost.
    status: { in: [...WORK_LEASED_STATUSES] },
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

export interface SweepExpiredCheckpointsInput {
  now?: Date;
  /** Override the retention window. Defaults to `CHECKPOINT_RETENTION_MS`. */
  retentionMs?: number;
  /** Safety cap so one sweep cannot rewrite an unbounded number of rows. */
  limit?: number;
}

/**
 * Drops the checkpoints of resumable runs nobody came back to.
 *
 * The other half of the bargain `finishRun` now makes. Keeping a checkpoint past
 * a terminal state is what makes resume possible; keeping it for ever is what
 * the blanket null was rightly trying to prevent, because a checkpoint is the
 * provider transcript — the goal, every tool result, and whatever the connectors
 * handed back. This is the sweep that lets both be true: a failed run can be
 * picked up for a week, and a failed run nobody picked up stops being a stored
 * copy of the work.
 *
 * Runs still `paused` are untouched, however old. A pause is a live state the
 * user chose and expects to return to, and expiring it would turn "I'll finish
 * this later" into a silently broken resume. If that needs bounding it needs its
 * own decision and its own sentence to the user, not this one's side effect.
 *
 * `prismaUnguarded`, and deliberately: this sweeps every account, which is the
 * one thing the ownership guard exists to notice, so it says so rather than
 * tripping it.
 */
export async function sweepExpiredCheckpoints(
  input: SweepExpiredCheckpointsInput = {}
): Promise<{ cleared: number }> {
  const now = input.now ?? new Date();
  const retentionMs = input.retentionMs ?? CHECKPOINT_RETENTION_MS;
  const limit = Math.min(Math.max(input.limit ?? 500, 1), 5_000);
  const cutoff = new Date(now.getTime() - retentionMs);

  const stale = await prismaUnguarded.workRun.findMany({
    where: {
      status: { in: [...WORK_TERMINAL_STATUSES] },
      finishedAt: { lt: cutoff },
      // `not: Prisma.DbNull` rather than a bare truthiness test: the column is
      // JSON, and a run finished before this sweep existed already has SQL NULL
      // there. Re-writing those every pass would make the sweep's own cost grow
      // with the age of the table rather than with the work there is to do.
      checkpoint: { not: Prisma.DbNull },
    },
    select: { id: true },
    orderBy: { finishedAt: "asc" },
    take: limit,
  });
  if (stale.length === 0) return { cleared: 0 };

  const cleared = await prismaUnguarded.workRun.updateMany({
    where: { id: { in: stale.map((run) => run.id) } },
    data: { checkpoint: Prisma.JsonNull },
  });
  return { cleared: cleared.count };
}

import "server-only";
import { Prisma } from "@prisma/client";
import type { WorkCommand, WorkRun, WorkSession } from "@prisma/client";
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
   * Written to the column, and read by nothing. There is no seam in the runtime
   * to hand it to. `WorkSessionOptions` in
   * runner/agent-core/src/work/session.ts takes a provider, a model, a budget,
   * a policy and a system suffix; `ProviderRequest` in
   * runner/agent-core/src/providers/types.ts carries `model`, `system`,
   * `messages`, `tools`, `maxTokens` and `signal`, and nothing else. The
   * Anthropic adapter never sends a `thinking` block and the OpenAI-compatible
   * one never sends `reasoning_effort`; both only read reasoning back off the
   * stream as `thinking_delta`. `ModelCapabilities.reasoningLevels` describes
   * what a model could be asked for and is wired to no request at all — the
   * proxy adapter reports it empty.
   *
   * Passing it through `systemSuffix` was the available alternative and is
   * rejected here: a sentence asking a model to think harder is not the
   * six-tier control the composer draws, and dressing one up as the other is
   * exactly how a preference comes to look saved and have no effect. The two
   * honest options are to give the runtime a reasoning parameter and thread it
   * through every adapter, or to take the control out of the composer. Until
   * one of them happens this column records a request nothing acts on, and the
   * popover promises a reader something Juno does not do.
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
        permissionPolicy: input.permissionPolicy ?? "balanced",
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

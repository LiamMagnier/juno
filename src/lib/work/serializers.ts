/**
 * The wire shapes of Juno Work, and the disclosure rules that produce them.
 *
 * One rule dominates the file: a `WorkFileGrant`'s `localPath` and
 * `resolvedRealPath` must never reach a web or iOS client. A phone supervising a
 * Mac says "tidy the folder you called Downloads"; it must not learn that the
 * folder is /Users/liam/Downloads. A path in a response body is a path in a
 * screenshot, in a support ticket, in a crash report, and in the next
 * prompt-injection payload that asks the agent to read something adjacent to
 * it. `serializeGrantForRemote` is the only shape that goes out to a client and
 * `serializeGrantForHost` is the only shape that carries the paths, and the two
 * are kept apart by the type system rather than by anyone remembering.
 *
 * No `server-only` here, for the same reason `code-workspace-privacy.ts` has
 * none: these are pure functions of a row, and disclosure rules are exactly the
 * thing that has to be exercised by a test that never opens a database.
 */

import type {
  Prisma,
  WorkApproval,
  WorkArtifact,
  WorkCommand,
  WorkEvent,
  WorkFileGrant,
  WorkHost,
  WorkRun,
  WorkSession,
} from "@prisma/client";
import type { EventVisibility } from "@/lib/event-envelope";
import {
  WORK_ACCESS_MODES,
  WORK_APPROVAL_DECISIONS,
  WORK_ARTIFACT_KINDS,
  WORK_CAPABILITIES,
  WORK_COMMAND_KINDS,
  WORK_COMMAND_STATUSES,
  WORK_DEGRADATION_KINDS,
  WORK_EFFECTIVE_TARGETS,
  WORK_EVENT_KINDS,
  WORK_GRANT_KINDS,
  WORK_HOST_STATES,
  WORK_PERMISSION_POLICIES,
  WORK_RISK_LEVELS,
  WORK_SENSITIVITIES,
  WORK_STATUSES,
  WORK_TARGETS,
  WORK_TERMINAL_REASONS,
  type WorkAccessMode,
  type WorkApprovalDecision,
  type WorkArtifactKind,
  type WorkCapability,
  type WorkCommandKind,
  type WorkCommandStatus,
  type WorkDegradation,
  type WorkDegradationKind,
  type WorkEffectiveTarget,
  type WorkEventKind,
  type WorkGrantKind,
  type WorkHostState,
  type WorkPermissionPolicy,
  type WorkRiskLevel,
  type WorkSensitivity,
  type WorkStatus,
  type WorkTarget,
  type WorkTerminalReason,
} from "@/lib/work/domain";

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

/**
 * Narrows a TEXT column back to the vocabulary in `domain.ts`.
 *
 * The columns are TEXT so a new status can ship as code (see the schema's
 * rationale), which means a row can legitimately hold a value written by a
 * newer deployment than the one reading it. Passing that value through
 * untouched breaks the generated Swift clients outright: they decode these
 * fields as closed enums, so one unrecognised status does not degrade a badge,
 * it fails the decode of the whole session and the user sees nothing at all.
 * Each call site therefore picks a fallback, and picks it for safety.
 */
function oneOf<T extends string>(allowed: readonly T[], value: string, fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * `interrupted` is the fallback for an unrecognised status on purpose.
 *
 * It is terminal, so an unreadable row cannot render as a spinner that never
 * resolves, and it is the one status that claims nothing about who decided:
 * "the executor died without reporting" is very close to the truth when this
 * build cannot say what the executor reported.
 */
function status(value: string): WorkStatus {
  return oneOf(WORK_STATUSES, value, "interrupted");
}

/** Unreadable policy resolves to the narrowest one. Never widen on a parse. */
function permissionPolicy(value: string): WorkPermissionPolicy {
  return oneOf(WORK_PERMISSION_POLICIES, value, "conservative");
}

/** Unreadable access mode resolves to read-only, for the same reason. */
function accessMode(value: string): WorkAccessMode {
  return oneOf(WORK_ACCESS_MODES, value, "read");
}

function iso(value: Date): string;
function iso(value: Date | null): string | null;
function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/**
 * Capabilities this build understands, from a JSONB array.
 *
 * Unknown entries are dropped rather than passed through: a capability name
 * this deployment cannot act on is not information a client can act on either,
 * and a UI that renders it produces a promise nothing will keep.
 */
function capabilityList(raw: Prisma.JsonValue): WorkCapability[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is WorkCapability =>
      typeof entry === "string" && (WORK_CAPABILITIES as readonly string[]).includes(entry)
  );
}

/**
 * Degradations, rebuilt field by field from a JSONB array.
 *
 * An entry missing its explanation is dropped entirely. A degradation the UI
 * cannot explain renders as a warning triangle with no sentence beside it,
 * which tells the user something went wrong and nothing about what — worse than
 * saying nothing, because it cannot be acted on.
 */
function degradationList(raw: Prisma.JsonValue): WorkDegradation[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, Prisma.JsonValue | undefined>;
    const kind = typeof record.kind === "string" ? record.kind : "";
    const explanation = typeof record.explanation === "string" ? record.explanation : "";
    if (!explanation || !(WORK_DEGRADATION_KINDS as readonly string[]).includes(kind)) return [];
    const subject = typeof record.subject === "string" ? record.subject : undefined;
    return [
      subject === undefined
        ? { kind: kind as WorkDegradationKind, explanation }
        : { kind: kind as WorkDegradationKind, explanation, subject },
    ];
  });
}

// ---------------------------------------------------------------------------
// Sessions and runs
// ---------------------------------------------------------------------------

export interface ClientWorkSession {
  id: string;
  projectId: string | null;
  conversationId: string | null;
  title: string;
  titleSource: string;
  goal: string;
  status: WorkStatus;
  needsAttention: boolean;
  requestedTarget: WorkTarget;
  preferredHostId: string | null;
  requestedModel: string | null;
  reasoningEffort: string | null;
  permissionPolicy: WorkPermissionPolicy;
  pinned: boolean;
  archived: boolean;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

export function serializeSession(session: WorkSession): ClientWorkSession {
  return {
    id: session.id,
    projectId: session.projectId,
    conversationId: session.conversationId,
    title: session.title,
    titleSource: session.titleSource,
    goal: session.goal,
    status: status(session.status),
    needsAttention: session.needsAttention,
    requestedTarget: oneOf(WORK_TARGETS, session.requestedTarget, "automatic"),
    preferredHostId: session.preferredHostId,
    requestedModel: session.requestedModel,
    reasoningEffort: session.reasoningEffort,
    permissionPolicy: permissionPolicy(session.permissionPolicy),
    pinned: session.pinned,
    archived: session.archived,
    lastActivityAt: iso(session.lastActivityAt),
    createdAt: iso(session.createdAt),
    updatedAt: iso(session.updatedAt),
  };
}

export interface ClientWorkRun {
  id: string;
  sessionId: string;
  attempt: number;
  /** manual | retry | schedule | trigger | resume | fork. */
  origin: string;
  scheduleId: string | null;
  status: WorkStatus;
  terminalReason: WorkTerminalReason | null;
  terminalDetail: string | null;
  requestedTarget: WorkTarget;
  effectiveTarget: WorkEffectiveTarget | null;
  hostId: string | null;
  requestedModel: string | null;
  effectiveModel: string | null;
  requiredCapabilities: WorkCapability[];
  availableCapabilities: WorkCapability[];
  degradation: WorkDegradation[];
  planVersion: number;
  budget: { maxCostMicroUsd: number; maxTokens: number; maxRuntimeMs: number };
  usage: { costMicroUsd: number; inputTokens: number; outputTokens: number };
  inputSensitivity: WorkSensitivity;
  outputSensitivity: WorkSensitivity;
  lastSeq: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Four columns are deliberately absent: `claimedBy`, `claimedAt`,
 * `leaseExpiresAt` and `idempotencyKey`.
 *
 * The first three name a piece of Juno's execution fleet and the schedule on
 * which it can be stolen from, which is infrastructure detail no client acts on
 * and an attacker would rather have. The fourth is the caller's own key,
 * meaningful only to whoever minted it; echoing it back to every reader of the
 * session turns a private retry token into a shared one. `permissionPolicy` is
 * absent for a different reason — it is the blob the executor enforced, and a
 * client that renders it is one refactor away from a client that submits it.
 */
export function serializeRun(run: WorkRun): ClientWorkRun {
  return {
    id: run.id,
    sessionId: run.sessionId,
    attempt: run.attempt,
    origin: run.origin,
    scheduleId: run.scheduleId,
    status: status(run.status),
    terminalReason:
      run.terminalReason === null ? null : oneOf(WORK_TERMINAL_REASONS, run.terminalReason, "interrupted"),
    terminalDetail: run.terminalDetail,
    requestedTarget: oneOf(WORK_TARGETS, run.requestedTarget, "automatic"),
    effectiveTarget:
      run.effectiveTarget === null ? null : oneOf(WORK_EFFECTIVE_TARGETS, run.effectiveTarget, "cloud"),
    hostId: run.hostId,
    requestedModel: run.requestedModel,
    effectiveModel: run.effectiveModel,
    requiredCapabilities: capabilityList(run.requiredCapabilities),
    availableCapabilities: capabilityList(run.availableCapabilities),
    degradation: degradationList(run.degradation),
    planVersion: run.planVersion,
    budget: {
      maxCostMicroUsd: run.maxCostMicroUsd,
      maxTokens: run.maxTokens,
      maxRuntimeMs: run.maxRuntimeMs,
    },
    usage: {
      costMicroUsd: run.costMicroUsd,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
    },
    // Sensitivity only ever rises, so an unreadable value must not be allowed
    // to lower it: `restricted` is the fallback, which at worst suppresses a
    // screenshot relay that would have been permitted.
    inputSensitivity: oneOf(WORK_SENSITIVITIES, run.inputSensitivity, "restricted"),
    outputSensitivity: oneOf(WORK_SENSITIVITIES, run.outputSensitivity, "restricted"),
    lastSeq: run.lastSeq,
    startedAt: iso(run.startedAt),
    finishedAt: iso(run.finishedAt),
    createdAt: iso(run.createdAt),
    updatedAt: iso(run.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// Events and approvals
// ---------------------------------------------------------------------------

export interface ClientWorkEvent {
  id: string;
  runId: string;
  seq: number;
  kind: WorkEventKind;
  payloadVersion: number;
  visibility: EventVisibility;
  payload: Prisma.JsonValue;
  /** The producer's idempotency key; clients dedupe replays on it. */
  eventKey: string | null;
  agentId: string | null;
  createdAt: string;
}

/**
 * Serializes one event, `visibility` included and nothing filtered.
 *
 * Filtering is the caller's, because only the caller knows who is asking: the
 * owner's own timeline, an operator log and an export have three different
 * answers. `userVisible`/`operatorVisible` in `event-envelope.ts` are the
 * predicates to apply — what this function guarantees is that the field they
 * need is present and honest, and that an event whose stored visibility is
 * unreadable is treated as `internal` rather than shown.
 */
export function serializeEvent(event: WorkEvent): ClientWorkEvent {
  return {
    id: event.id,
    runId: event.runId,
    seq: event.seq,
    kind: oneOf(WORK_EVENT_KINDS, event.kind, "error"),
    payloadVersion: event.payloadVersion,
    visibility: oneOf(["user", "operator", "internal"] as const, event.visibility, "internal"),
    payload: event.payload,
    eventKey: event.eventKey,
    agentId: event.agentId,
    createdAt: iso(event.createdAt),
  };
}

export interface ClientWorkApproval {
  id: string;
  runId: string;
  action: string;
  risk: WorkRiskLevel;
  summary: string;
  detail: Prisma.JsonValue;
  detailVersion: number;
  /**
   * The action digest, so a client can prove the card it rendered is the row it
   * is answering. `policyDigest` is not here: it is the server's replay
   * defence and there is nothing a client could do with it.
   */
  actionDigest: string;
  decision: WorkApprovalDecision;
  decidedAt: string | null;
  decidedVia: string | null;
  expiresAt: string;
  createdAt: string;
}

export function serializeApproval(approval: WorkApproval): ClientWorkApproval {
  return {
    id: approval.id,
    runId: approval.runId,
    action: approval.action,
    // An unrecognised risk level is treated as the highest, so a client that
    // cannot name it still asks rather than quietly proceeding.
    risk: oneOf(WORK_RISK_LEVELS, approval.risk, "irreversible"),
    summary: approval.summary,
    detail: approval.detail,
    detailVersion: approval.detailVersion,
    actionDigest: approval.actionDigest,
    decision: oneOf(WORK_APPROVAL_DECISIONS, approval.decision, "pending"),
    decidedAt: iso(approval.decidedAt),
    decidedVia: approval.decidedVia,
    expiresAt: iso(approval.expiresAt),
    createdAt: iso(approval.createdAt),
  };
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export interface ClientWorkArtifact {
  id: string;
  sessionId: string;
  identifier: string;
  title: string;
  kind: WorkArtifactKind;
  mimeType: string;
  currentVersion: number;
  /** Null until the export validator has opened the file back up. */
  validatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function serializeArtifact(artifact: WorkArtifact): ClientWorkArtifact {
  return {
    id: artifact.id,
    sessionId: artifact.sessionId,
    identifier: artifact.identifier,
    title: artifact.title,
    kind: oneOf(WORK_ARTIFACT_KINDS, artifact.kind, "bundle"),
    mimeType: artifact.mimeType,
    currentVersion: artifact.currentVersion,
    validatedAt: iso(artifact.validatedAt),
    createdAt: iso(artifact.createdAt),
    updatedAt: iso(artifact.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

export interface ClientWorkHost {
  id: string;
  deviceId: string;
  displayName: string;
  platform: string;
  appVersion: string;
  protocolVersion: number;
  /** The master switch. False means every toggle below is off regardless. */
  enabled: boolean;
  allowsFileWork: boolean;
  allowsBrowser: boolean;
  allowsComputerUse: boolean;
  allowsShell: boolean;
  allowsBackground: boolean;
  capabilities: Prisma.JsonValue;
  capabilitiesVersion: number;
  allowedApps: Prisma.JsonValue;
  blockedApps: Prisma.JsonValue;
  allowedDomains: Prisma.JsonValue;
  approvalPolicy: WorkPermissionPolicy;
  state: WorkHostState;
  lastSeenAt: string;
  activeRunCount: number;
  queuedRunCount: number;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The host as every client may see it.
 *
 * The advertised capability toggles are passed through as the host wrote them
 * and are never combined into one "can do local work" boolean. Presence and
 * capability are different facts — the same distinction `serializeDevice` draws
 * with `servesQueuedTasks` — and a client that collapses them queues file work
 * at a Mac that is online, signed in, and has file work switched off.
 */
export function serializeHost(host: WorkHost): ClientWorkHost {
  return {
    id: host.id,
    deviceId: host.deviceId,
    displayName: host.displayName,
    platform: host.platform,
    appVersion: host.appVersion,
    protocolVersion: host.protocolVersion,
    enabled: host.enabled,
    allowsFileWork: host.allowsFileWork,
    allowsBrowser: host.allowsBrowser,
    allowsComputerUse: host.allowsComputerUse,
    allowsShell: host.allowsShell,
    allowsBackground: host.allowsBackground,
    capabilities: host.capabilities,
    capabilitiesVersion: host.capabilitiesVersion,
    allowedApps: host.allowedApps,
    blockedApps: host.blockedApps,
    allowedDomains: host.allowedDomains,
    approvalPolicy: permissionPolicy(host.approvalPolicy),
    // A host whose state is unreadable is offline, not online: the cost of
    // being wrong that way is a user who waits, and the other way is a task
    // queued at a machine that will never claim it.
    state: oneOf(WORK_HOST_STATES, host.state, "offline"),
    lastSeenAt: iso(host.lastSeenAt),
    activeRunCount: host.activeRunCount,
    queuedRunCount: host.queuedRunCount,
    revokedAt: iso(host.revokedAt),
    createdAt: iso(host.createdAt),
    updatedAt: iso(host.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// File grants — the disclosure boundary
// ---------------------------------------------------------------------------

/**
 * A grant as a web or iOS client may see it: an opaque handle and a name.
 *
 * `localPath` and `resolvedRealPath` are declared here as `?: never`, and that
 * is the whole mechanism. Without them `HostWorkGrant` — which has every field
 * this interface has, plus two — is structurally assignable to
 * `ClientWorkGrant`, so a route handler declared to return the remote shape
 * could hand back the host shape and TypeScript would accept it: excess
 * property checks only fire on fresh object literals, never on a value passed
 * through a variable or a function return. Declaring the paths as `never` makes
 * that assignment an error at the point it is written, which is the only place
 * anyone will be looking.
 */
export interface ClientWorkGrant {
  id: string;
  kind: WorkGrantKind;
  displayName: string;
  accessMode: WorkAccessMode;
  hostId: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  localPath?: never;
  resolvedRealPath?: never;
}

/** A grant as the Mac that owns the path may see it, and nobody else. */
export interface HostWorkGrant {
  id: string;
  kind: WorkGrantKind;
  displayName: string;
  accessMode: WorkAccessMode;
  hostId: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  localPath: string | null;
  resolvedRealPath: string | null;
}

/**
 * Builds the remote grant shape by construction.
 *
 * Every field is named. Nothing is spread from the row and nothing is deleted
 * from a copy, so a column added to `WorkFileGrant` next quarter — a bookmark
 * blob, a volume UUID, a second path under a different name — cannot ride out
 * to a phone because somebody forgot to add it to a delete list.
 */
export function serializeGrantForRemote(grant: WorkFileGrant): ClientWorkGrant {
  return {
    id: grant.id,
    kind: oneOf(WORK_GRANT_KINDS, grant.kind, "local_folder"),
    displayName: grant.displayName,
    accessMode: accessMode(grant.accessMode),
    hostId: grant.hostId,
    revokedAt: iso(grant.revokedAt),
    lastUsedAt: iso(grant.lastUsedAt),
  };
}

/**
 * The same grant plus the two paths, for the host that owns them.
 *
 * Built on top of the remote shape rather than beside it, so there is exactly
 * one place in the codebase where a stored path is added to a response, and it
 * is this function.
 */
export function serializeGrantForHost(grant: WorkFileGrant): HostWorkGrant {
  return {
    ...serializeGrantForRemote(grant),
    localPath: grant.localPath,
    resolvedRealPath: grant.resolvedRealPath,
  };
}

/**
 * The unqualified name, bound to the safe half on purpose.
 *
 * Code that reaches for `serializeGrant` without having thought about which
 * side of the boundary it is on gets the shape with no paths in it. Wanting the
 * paths has to be said out loud.
 */
export const serializeGrant = serializeGrantForRemote;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface ClientWorkCommand {
  id: string;
  hostId: string;
  sessionId: string;
  runId: string | null;
  kind: WorkCommandKind;
  payload: Prisma.JsonValue;
  payloadVersion: number;
  status: WorkCommandStatus;
  result: Prisma.JsonValue;
  error: string | null;
  /** The caller's own key, echoed so a retrying client recognises its command. */
  idempotencyKey: string;
  expiresAt: string;
  leaseExpiresAt: string | null;
  attempts: number;
  createdAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  /** Names of payload or result keys withheld from this shape. */
  redacted?: never;
}

/**
 * Payload and result keys a remote client may read, per command kind.
 *
 * An allowlist rather than a denylist, for the same reason the grant serialiser
 * names its fields instead of deleting from the row: the value that leaks is
 * always the one added after the denylist was written. A `grant_folder`
 * command is the concrete case — the client sends a display name and the host
 * answers with the absolute path it resolved, and that answer has no business
 * travelling back to a phone.
 *
 * A kind absent from this table yields an empty object rather than a
 * pass-through, so a command kind added next quarter is silent to remote
 * clients until somebody decides what it may say.
 */
// Exhaustive over WorkCommandKind, deliberately not Partial. A kind absent from
// a Partial map yields an empty payload, which is silent in the worst way: the
// host claims the command, receives nothing to act on, and reports a failure
// that names none of this. Making the map total turns "somebody added a command
// kind and did not decide what a remote client may read of it" into a compile
// error, which is the moment the decision is actually being made.
const REMOTE_PAYLOAD_KEYS: Record<WorkCommandKind, readonly string[]> = {
  // Everything here originated on the client, so echoing it discloses nothing
  // it did not already have.
  answer: ["questionId", "text"],
  // The instruction itself, which is the whole command. It is the sentence the
  // user typed on the surface reading this back, so echoing it discloses
  // nothing — and withholding it would leave a phone rendering its owner's own
  // steer as an empty row while `serializeCommandForHost` hands the Mac the
  // text it acts on.
  steer: ["text"],
  approve: ["approvalId", "actionDigest"],
  deny: ["approvalId", "actionDigest", "reason"],
  undo: ["batchId"],
  // The goal is the sentence the user typed into the composer and the model is
  // the one they picked, so both fall under the rule above: a client reading
  // this back is being shown its own request. They are here because the Mac
  // needs them — `DesktopWorkRunHost` reads `payload.goal` and refuses with
  // `noGoal` without it — and the claim endpoint answers with the remote shape
  // like every other route under /api/work. Widening the allowlist is the way
  // to do that; reaching for `serializeCommandForHost` in a route is not, and
  // there is a CI gate that says so, because that shape also passes through
  // the resolved filesystem path in a `grant_folder` result.
  start: ["runId", "target", "goal", "model"],
  pause: ["runId"],
  // Resume carries the whole start payload, not just the id: a Mac relaunched
  // while a run was parked starts a fresh loop and has no goal to resume from.
  resume: ["runId", "goal", "model"],
  stop: ["runId", "reason"],
  grant_folder: ["displayName", "accessMode"],
  revoke_grant: ["grantId"],
  refresh_capabilities: [],
  ping: [],
};

/**
 * Result keys a remote client may read. Deliberately much smaller, and total for
 * the same reason as the payload map above.
 */
const REMOTE_RESULT_KEYS: Record<WorkCommandKind, readonly string[]> = {
  grant_folder: ["grantId", "displayName", "accessMode"],
  revoke_grant: ["grantId"],
  undo: ["reversedCount", "unreversedCount"],
  start: ["runId"],
  ping: ["hostState"],
  // The control plane answers with nothing a client needs beyond the
  // acknowledgement itself: whether a pause took effect is a fact about the
  // run, which the client is already streaming, and repeating it here would be
  // a second place for it to be wrong.
  pause: [],
  resume: [],
  stop: [],
  answer: [],
  // Nothing beyond the acknowledgement. Whether the Mac took the instruction is
  // the command's own `status`, and a second field saying so here would be a
  // second place for it to disagree with the first.
  steer: [],
  approve: [],
  deny: [],
  refresh_capabilities: [],
};

function pick(
  value: Prisma.JsonValue,
  allowed: readonly string[]
): { picked: Record<string, Prisma.JsonValue>; withheld: string[] } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { picked: {}, withheld: [] };
  }
  const source = value as Record<string, Prisma.JsonValue>;
  const picked: Record<string, Prisma.JsonValue> = {};
  const withheld: string[] = [];
  for (const key of Object.keys(source)) {
    if (allowed.includes(key)) picked[key] = source[key];
    else withheld.push(key);
  }
  return { picked, withheld };
}

/** A command as a web or iOS client may see it, with the host's answers filtered. */
export interface RemoteWorkCommand extends Omit<ClientWorkCommand, "redacted"> {
  /**
   * Keys that existed and were withheld. Present so a remote surface can say
   * "the Mac returned more than this" rather than quietly showing a truncated
   * result as though it were the whole one.
   */
  redacted: string[];
}

/**
 * A command as the host that must execute it sees it: payload intact.
 *
 * A host cannot carry out an instruction it is not allowed to read, so this
 * shape passes the payload through. It is the only shape that does.
 */
export function serializeCommandForHost(command: WorkCommand): ClientWorkCommand {
  return {
    id: command.id,
    hostId: command.hostId,
    sessionId: command.sessionId,
    runId: command.runId,
    kind: oneOf(WORK_COMMAND_KINDS, command.kind, "ping"),
    payload: command.payload,
    payloadVersion: command.payloadVersion,
    // An unreadable status is `failed`, never `pending`: a command nobody can
    // classify must not be handed to a host to run a second time.
    status: oneOf(WORK_COMMAND_STATUSES, command.status, "failed"),
    result: command.result,
    error: command.error,
    idempotencyKey: command.idempotencyKey,
    expiresAt: iso(command.expiresAt),
    leaseExpiresAt: iso(command.leaseExpiresAt),
    attempts: command.attempts,
    createdAt: iso(command.createdAt),
    claimedAt: iso(command.claimedAt),
    completedAt: iso(command.completedAt),
  };
}

/**
 * A command as everyone other than the owning Mac sees it.
 *
 * The payload and the result are filtered through per-kind allowlists. The case
 * this exists for is `grant_folder`: the phone sends a display name, the user
 * at the Mac picks a folder in a file dialog, and the host answers with the
 * absolute path it resolved. Echoing that answer back would hand the phone the
 * very thing the whole grant design keeps from it, through a field nobody
 * thinks of as a path.
 */
export function serializeCommandForRemote(command: WorkCommand): RemoteWorkCommand {
  const kind = oneOf(WORK_COMMAND_KINDS, command.kind, "ping");
  const payload = pick(command.payload, REMOTE_PAYLOAD_KEYS[kind]);
  const result = pick(command.result ?? null, REMOTE_RESULT_KEYS[kind]);
  return {
    id: command.id,
    hostId: command.hostId,
    sessionId: command.sessionId,
    runId: command.runId,
    kind,
    payload: payload.picked,
    payloadVersion: command.payloadVersion,
    status: oneOf(WORK_COMMAND_STATUSES, command.status, "failed"),
    result: result.picked,
    error: command.error,
    idempotencyKey: command.idempotencyKey,
    expiresAt: iso(command.expiresAt),
    leaseExpiresAt: iso(command.leaseExpiresAt),
    attempts: command.attempts,
    createdAt: iso(command.createdAt),
    claimedAt: iso(command.claimedAt),
    completedAt: iso(command.completedAt),
    redacted: [...payload.withheld, ...result.withheld].sort(),
  };
}

/**
 * The unqualified name, bound to the filtered half, exactly as `serializeGrant`
 * is bound to the pathless one. Wanting the raw payload has to be said out loud.
 */
export const serializeCommand = serializeCommandForRemote;

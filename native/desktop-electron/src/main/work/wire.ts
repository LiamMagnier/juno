/**
 * The Juno backend's real Work shapes, and the mapping onto the IPC contract.
 *
 * Two vocabularies meet in this file and neither one is allowed to bend.
 *
 * **Below** is what `/api/work/*` actually sends — `serializeSession`,
 * `serializeRun`, `serializeEvent`, `serializeApproval`, `serializeHost` in
 * `src/lib/work/serializers.ts`, plus `/api/connectors` and `/api/models`. Each
 * one is declared as a Zod schema here and every response is parsed through it
 * before anything else in this process looks at it.
 *
 * **Above** is `src/shared/contracts/work.ts`, which the renderer is written
 * against and which the IPC router validates on the way out.
 *
 * They do not line up field for field, and the honest response to that is to
 * write the mapping down rather than to widen the contract until the mismatch
 * disappears. Every place the wire is missing something the contract asks for
 * carries a `GAP` comment naming what is absent and what this file does instead.
 *
 * Nothing here logs. A goal, an answer and an event payload all pass through
 * these functions, and none of them is a thing to write to a file the user will
 * later paste into a bug report.
 */

import { z } from 'zod';
import {
  WorkApprovalSchema,
  WorkEmittedEventSchema,
  WorkQuestionSchema,
  type WorkApproval,
  type WorkConnectorRef,
  type WorkEmittedEvent,
  type WorkGrant,
  type WorkHostRef,
  type WorkQuestion,
  type WorkRun,
  type WorkSession,
  type WorkSessionSummary,
  type WorkSkillRef,
} from '../../shared/contracts/work.js';
import {
  WORK_PERMISSION_POLICIES,
  WORK_SENSITIVITIES,
  WORK_STATUSES,
  WORK_TARGETS,
  WORK_TERMINAL_REASONS,
  needsAttention as statusNeedsAttention,
  type WorkCapability,
  type WorkPermissionPolicy,
  type WorkSensitivity,
  type WorkStatus,
} from '../../shared/contracts/work-vocabulary.js';

/* -------------------------------------------------------------------------- */
/* Wire vocabulary                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The server narrows unreadable enum columns to a fallback before serialising
 * (`oneOf` in `serializers.ts`), so these are closed sets on the wire. They are
 * still parsed as plain strings and coerced here rather than as `z.enum`, so a
 * value added server-side lands as a coercion rather than as a whole snapshot
 * failing to parse and a blank panel.
 */
const wireStatus = z.string();
const wireEnum = z.string();

function coerce<T extends string>(values: readonly T[], raw: string, fallback: T): T {
  return (values as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/* -------------------------------------------------------------------------- */
/* Wire schemas — exactly what the routes send                                 */
/* -------------------------------------------------------------------------- */

/** `serializeSession`. `GET/POST /api/work/sessions`, `GET /api/work/sessions/[id]`. */
export const WireSessionSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  conversationId: z.string().nullable(),
  title: z.string(),
  titleSource: z.string(),
  goal: z.string(),
  status: wireStatus,
  needsAttention: z.boolean(),
  requestedTarget: wireEnum,
  preferredHostId: z.string().nullable(),
  requestedModel: z.string().nullable(),
  reasoningEffort: z.string().nullable(),
  permissionPolicy: wireEnum,
  pinned: z.boolean(),
  archived: z.boolean(),
  lastActivityAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WireSession = z.infer<typeof WireSessionSchema>;

/** `serializeRun`. */
export const WireRunSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  attempt: z.number(),
  origin: z.string(),
  scheduleId: z.string().nullable(),
  status: wireStatus,
  terminalReason: z.string().nullable(),
  terminalDetail: z.string().nullable(),
  requestedTarget: wireEnum,
  effectiveTarget: z.string().nullable(),
  hostId: z.string().nullable(),
  requestedModel: z.string().nullable(),
  effectiveModel: z.string().nullable(),
  requiredCapabilities: z.array(z.string()),
  availableCapabilities: z.array(z.string()),
  degradation: z.array(z.unknown()),
  approvalMode: z.string().nullable(),
  approvalModeNarrowedByHost: z.boolean(),
  planVersion: z.number(),
  budget: z.object({
    maxCostMicroUsd: z.number(),
    maxTokens: z.number(),
    maxRuntimeMs: z.number(),
  }),
  usage: z.object({
    costMicroUsd: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
  }),
  inputSensitivity: wireEnum,
  outputSensitivity: wireEnum,
  lastSeq: z.number(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WireRun = z.infer<typeof WireRunSchema>;

/** `serializeEvent`. The payload is a JSON blob; its shape is per-kind. */
export const WireEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  seq: z.number(),
  kind: z.string(),
  payloadVersion: z.number(),
  visibility: z.string(),
  payload: z.unknown(),
  eventKey: z.string().nullable(),
  agentId: z.string().nullable(),
  createdAt: z.string(),
});
export type WireEvent = z.infer<typeof WireEventSchema>;

/** `serializeApproval`. Note what is NOT here: `policyDigest`. */
export const WireApprovalSchema = z.object({
  id: z.string(),
  runId: z.string(),
  action: z.string(),
  risk: wireEnum,
  summary: z.string(),
  detail: z.unknown(),
  detailVersion: z.number(),
  actionDigest: z.string(),
  decision: wireEnum,
  decidedAt: z.string().nullable(),
  decidedVia: z.string().nullable(),
  expiresAt: z.string(),
  createdAt: z.string(),
});
export type WireApproval = z.infer<typeof WireApprovalSchema>;

/** `serializeHost`. `GET /api/work/hosts`. */
export const WireHostSchema = z.object({
  id: z.string(),
  deviceId: z.string(),
  displayName: z.string(),
  platform: z.string(),
  appVersion: z.string(),
  protocolVersion: z.number(),
  enabled: z.boolean(),
  allowsFileWork: z.boolean(),
  allowsBrowser: z.boolean(),
  allowsComputerUse: z.boolean(),
  allowsShell: z.boolean(),
  allowsBackground: z.boolean(),
  approvalPolicy: wireEnum,
  state: wireEnum,
  lastSeenAt: z.string(),
  activeRunCount: z.number(),
  queuedRunCount: z.number(),
  revokedAt: z.string().nullable(),
});
export type WireHost = z.infer<typeof WireHostSchema>;

/** `serializeSkill`. `GET /api/work/skills`. */
export const WireSkillSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  currentVersion: z.number(),
  enabled: z.boolean(),
  trust: z.string(),
  autoSelect: z.boolean(),
  securityStatus: z.string(),
});
export type WireSkill = z.infer<typeof WireSkillSchema>;

/** `GET /api/connectors`. Not a Work route; the same bearer opens it. */
export const WireConnectorSchema = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string(),
  description: z.string(),
  capability: z.string(),
  configured: z.boolean(),
  connected: z.boolean(),
  accountLabel: z.string().nullable(),
  connectedAt: z.string().nullable(),
});
export type WireConnector = z.infer<typeof WireConnectorSchema>;

/**
 * `GET /api/models`. Loose on purpose: this is the general chat catalog, it
 * carries a dozen fields Work has no use for, and a strict schema here would
 * break the composer every time a metrics column is added to it.
 */
export const WireModelSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  label: z.string().optional(),
  comingSoon: z.boolean().optional(),
  available: z.boolean().optional(),
  locked: z.boolean().optional(),
});
export type WireModel = z.infer<typeof WireModelSchema>;

/** `GET /api/work/sessions/[id]/context`. */
export const WireSessionContextSchema = z.object({
  projectId: z.string().nullable(),
  model: z.string().nullable(),
  reasoningEffort: z.string().nullable(),
  permissionPolicy: z.string(),
  connectorIds: z.array(z.string()).optional(),
  attachmentIds: z.array(z.string()),
  attachments: z.array(z.object({ id: z.string(), displayName: z.string() })),
  skillSlug: z.string().optional(),
});
export type WireSessionContext = z.infer<typeof WireSessionContextSchema>;

/* ---- Response envelopes -------------------------------------------------- */

export const SessionListResponseSchema = z.object({ sessions: z.array(WireSessionSchema) });
export const SessionDetailResponseSchema = z.object({
  session: WireSessionSchema,
  run: WireRunSchema.nullable(),
  approvals: z.array(WireApprovalSchema),
});
export const SessionCreateResponseSchema = z.object({
  session: WireSessionSchema,
  replay: z.boolean().optional(),
});
export const RunResponseSchema = z.object({ run: WireRunSchema });
export const SessionContextResponseSchema = z.object({ context: WireSessionContextSchema });
export const HostListResponseSchema = z.object({ hosts: z.array(WireHostSchema) });
export const SkillListResponseSchema = z.object({ skills: z.array(WireSkillSchema) });
export const ConnectorListResponseSchema = z.object({ connectors: z.array(WireConnectorSchema) });
export const ModelListResponseSchema = z.object({ models: z.array(WireModelSchema) });
export const AnswerResponseSchema = z.object({
  lastSeq: z.number(),
  replay: z.boolean(),
  delivered: z.boolean().optional(),
  explanation: z.string().optional(),
});
export const ApprovalDecisionResponseSchema = z.object({
  approval: WireApprovalSchema,
  replay: z.boolean().optional(),
});

/** The SSE frames `GET /api/work/sessions/[id]/events` writes. */
export const WireStreamFrameSchema = z.object({
  type: z.enum(['snapshot', 'events', 'done']),
  session: WireSessionSchema,
  run: WireRunSchema.nullable(),
  events: z.array(WireEventSchema).default([]),
  approvals: z.array(WireApprovalSchema).default([]),
});
export type WireStreamFrame = z.infer<typeof WireStreamFrameSchema>;

/* -------------------------------------------------------------------------- */
/* Mapping — wire onto contract                                                */
/* -------------------------------------------------------------------------- */

function status(raw: string): WorkStatus {
  return coerce(WORK_STATUSES, raw, 'draft');
}

function policy(raw: string | null): WorkPermissionPolicy {
  /* Narrowest on an unreadable value. Permission only ever narrows on the way
     down in this codebase, and a client that guessed `permissive` would draw a
     task as freer than the server will run it. */
  return raw === null ? 'conservative' : coerce(WORK_PERMISSION_POLICIES, raw, 'conservative');
}

function sensitivity(raw: string): WorkSensitivity {
  /* `restricted` on an unreadable value, matching `serializeRun`: sensitivity
     only ever rises, so a value nobody can read must not be allowed to lower it. */
  return coerce(WORK_SENSITIVITIES, raw, 'restricted');
}

/**
 * Runtime, which the wire does not carry.
 *
 * `WorkUsage` asks for `runtimeMs` and the run row has only `startedAt` and
 * `finishedAt`. Computed from those two rather than reported as zero, because
 * zero next to a runtime ceiling reads as "no time has been spent" on a run that
 * has been going for an hour. A run that has not started has spent no time, and
 * that zero is true.
 */
function runtimeMs(run: WireRun, now: number): number {
  if (run.startedAt === null) return 0;
  const started = Date.parse(run.startedAt);
  if (!Number.isFinite(started)) return 0;
  const ended = run.finishedAt === null ? now : Date.parse(run.finishedAt);
  return Math.max(0, (Number.isFinite(ended) ? ended : now) - started);
}

export interface SessionMappingExtras {
  readonly run: WireRun | null;
  readonly grants: readonly WorkGrant[];
  readonly connectors: readonly WorkConnectorRef[];
  readonly skill: WorkSkillRef | null;
  readonly now: number;
}

/**
 * `ClientWorkSession` → `WorkSession`.
 *
 * GAP — `sensitivity`: the session row has none. It lives on the *run*
 * (`inputSensitivity`/`outputSensitivity`), because sensitivity is a property of
 * what an attempt actually read. Taken from the current run's output
 * sensitivity, and `internal` when there is no run yet — a task nobody has
 * dispatched has read nothing, and claiming `public` about it would be a
 * classification nothing supports.
 *
 * GAP — `attempts`: not a column. Derived from the highest attempt number, which
 * is what `GET /api/work/sessions/[id]` returns as `run`. A session with no run
 * has had none.
 *
 * GAP — `grants`, `connectors`, `skill`: three separate joins the session
 * serializer deliberately does not perform. They come from
 * `GET /api/work/sessions/[id]/context`, and are passed in rather than faked so
 * a caller that has not fetched the context gets empty lists it can see are
 * empty rather than plausible ones it cannot.
 */
export function toWorkSession(wire: WireSession, extras: SessionMappingExtras): WorkSession {
  return {
    id: wire.id,
    title: wire.title,
    goal: wire.goal,
    status: status(wire.status),
    target: coerce(WORK_TARGETS, wire.requestedTarget, 'automatic'),
    permissionPolicy: policy(wire.permissionPolicy),
    model: wire.requestedModel,
    sensitivity: extras.run === null ? 'internal' : sensitivity(extras.run.outputSensitivity),
    createdAt: wire.createdAt,
    updatedAt: wire.updatedAt,
    attempts: extras.run?.attempt ?? 0,
    pinned: wire.pinned,
    archived: wire.archived,
    latestRunId: extras.run?.id ?? null,
    grants: [...extras.grants],
    connectors: [...extras.connectors],
    skill: extras.skill,
    conversationId: wire.conversationId,
  };
}

/**
 * `ClientWorkRun` → `WorkRun`.
 *
 * GAP — `target`: the contract types it as `'cloud' | 'local'` because
 * `automatic` never survives dispatch. `effectiveTarget` is null until the run
 * is dispatched, and `cloud` is the substitution — it is the target a run with
 * no host is going to get, and the alternative would be widening the contract's
 * type for a transient.
 *
 * GAP — `usage.tokens`: the wire reports input and output separately and never
 * a total. Summed here, and both halves are passed through as well so a reader
 * can check the arithmetic.
 *
 * GAP — `permissionPolicy`: `approvalMode` is null on a run whose stored policy
 * blob this build cannot read. Narrowed to `conservative`; see `policy`.
 */
export function toWorkRun(wire: WireRun, now: number): WorkRun {
  return {
    id: wire.id,
    sessionId: wire.sessionId,
    attempt: wire.attempt,
    status: status(wire.status),
    target: wire.effectiveTarget === 'local' ? 'local' : 'cloud',
    hostId: wire.hostId,
    model: wire.effectiveModel ?? wire.requestedModel ?? '',
    permissionPolicy: policy(wire.approvalMode),
    startedAt: wire.startedAt,
    endedAt: wire.finishedAt,
    terminalReason:
      wire.terminalReason === null
        ? null
        : coerce(WORK_TERMINAL_REASONS, wire.terminalReason, 'interrupted'),
    terminalDetail: wire.terminalDetail,
    usage: {
      costMicroUsd: wire.usage.costMicroUsd,
      tokens: wire.usage.inputTokens + wire.usage.outputTokens,
      runtimeMs: runtimeMs(wire, now),
      inputTokens: wire.usage.inputTokens,
      outputTokens: wire.usage.outputTokens,
    },
    budget: wire.budget,
    lastSeq: wire.lastSeq,
  };
}

/**
 * `ClientWorkSession` → `WorkSessionSummary`, for the task list.
 *
 * `needsAttention` is the server's own column, transcribed rather than
 * recomputed from the status — `setSessionAttention` clears it the moment a
 * question is answered, before the executor has moved the run off
 * `waiting_input`, and re-deriving it here would put a task back on the "Needs
 * you" list seconds after somebody dealt with it.
 *
 * GAP — `attempts` and `openRequestSummary`: neither is on the list route.
 * `attempts` is reported as 0 for every row, and `openRequestSummary` as null.
 * Filling either from the status would be a claim the list cannot support: a
 * summary invented from `waiting_approval` would put a made-up sentence where
 * the actual action is meant to be.
 */
export function toWorkSessionSummary(wire: WireSession): WorkSessionSummary {
  return {
    id: wire.id,
    title: wire.title,
    goal: wire.goal,
    status: status(wire.status),
    updatedAt: wire.updatedAt,
    attempts: 0,
    pinned: wire.pinned,
    archived: wire.archived,
    needsAttention: wire.needsAttention,
    openRequestSummary: null,
  };
}

/**
 * `ClientWorkApproval` → `WorkApproval`.
 *
 * GAP — `policyDigest` and `digestInput`. `serializeApproval` sends neither, and
 * the omission is deliberate and correct on the server's side: the policy digest
 * is its replay defence and there is nothing a client could do with it. The
 * contract asks for both because the card round-trips them. Both are sent as
 * empty strings, which is honest — this client holds no digest input — and the
 * decision route only ever checks `actionDigest`, which IS carried, so the
 * substitution defence the whole mechanism exists for is intact.
 */
export function toWorkApproval(wire: WireApproval): WorkApproval | null {
  const candidate = {
    id: wire.id,
    callId: wire.id,
    action: wire.action,
    tool: wire.action,
    risk: wire.risk,
    summary: wire.summary,
    detail: isRecord(wire.detail) ? wire.detail : {},
    digestInput: '',
    actionDigest: wire.actionDigest,
    policyDigest: '',
    expiresAt: wire.expiresAt,
    decision: wire.decision,
    decidedAt: wire.decidedAt,
  };
  const parsed = WorkApprovalSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `ClientWorkEvent` → `WorkEmittedEvent`, or null.
 *
 * The wire event is an envelope with a per-kind JSON payload; the contract's
 * event is that payload flattened with `kind`, `seq` and `at` on it. Flattening
 * is the whole of the transformation, plus exactly one fill-in — see
 * `user_message` below — and anything that still does not validate is dropped
 * rather than coerced.
 *
 * Dropping is the right failure. An event whose payload does not match the
 * contract is an event this build cannot draw, and inventing the missing fields
 * would put a card on screen making claims nothing sent. The caller counts the
 * drops and logs the count with the kinds, never the payloads.
 */
export function toWorkEvent(wire: WireEvent): WorkEmittedEvent | null {
  if (wire.visibility !== 'user') return null;
  const payload = isRecord(wire.payload) ? wire.payload : {};

  const flattened: Record<string, unknown> = {
    ...payload,
    kind: wire.kind,
    seq: wire.seq,
    at: wire.createdAt,
  };

  /* The one fill-in. `user_message` is written by the answer route as
     `{text, answeredVia, steering}` — `workSteeringPayload` — and the contract
     also asks whether the run has picked it up. Nothing on the wire says, and
     `false` is both the conservative reading and the one the UI needs: an
     instruction not known to have been consumed is drawn as still pending,
     which is the state a reader can act on. */
  if (wire.kind === 'user_message' && typeof flattened['consumed'] !== 'boolean') {
    flattened['consumed'] = false;
  }

  const parsed = WorkEmittedEventSchema.safeParse(flattened);
  return parsed.success ? (parsed.data as WorkEmittedEvent) : null;
}

/**
 * The open questions, read out of the event log.
 *
 * There is no questions route and no `questions` column: a question is a
 * `question_asked` event and it stops being open when a `question_answered`
 * event names it. That is the only place the answer lives, so this is a fold
 * over the log rather than a fetch.
 */
export function openQuestions(events: readonly WorkEmittedEvent[]): WorkQuestion[] {
  const open = new Map<string, WorkQuestion>();
  for (const event of events) {
    if (event.kind === 'question_asked') {
      const parsed = WorkQuestionSchema.safeParse(event.question);
      if (parsed.success) open.set(parsed.data.id, parsed.data);
    } else if (event.kind === 'question_answered') {
      open.delete(event.questionId);
    }
  }
  return [...open.values()];
}

/**
 * `ClientWorkHost` → `WorkHostRef`.
 *
 * GAP — `capabilities`: the host row carries a free-form `capabilities` JSON
 * blob AND five booleans. The booleans are what `hostCapabilityView` and
 * `selectTarget` actually read, so they are what is transcribed here; the blob
 * is not, because a client that trusted it could show a Mac as able to do file
 * work while the toggle that governs it is off.
 *
 * A revoked or disabled Mac advertises nothing. That is not a display choice —
 * `admissionRefusal` refuses a run at either of them — so a composer that still
 * offered the capability would be offering a run that cannot start.
 */
export function toWorkHostRef(wire: WireHost): WorkHostRef {
  const usable = wire.enabled && wire.revokedAt === null;
  const advertised: WorkCapability[] = [];
  if (usable) {
    if (wire.allowsFileWork) advertised.push('local_files');
    if (wire.allowsBrowser) advertised.push('local_browser');
    if (wire.allowsComputerUse) advertised.push('local_computer_use', 'local_apps');
    if (wire.allowsShell) advertised.push('local_shell');
    if (wire.allowsBackground) advertised.push('background_continuation');
  }
  return {
    id: wire.id,
    name: wire.displayName,
    state: usable ? coerceHostState(wire.state) : 'offline',
    lastSeenAt: wire.lastSeenAt,
    capabilities: advertised,
    maxPermissionPolicy: policy(wire.approvalPolicy),
  };
}

function coerceHostState(raw: string): WorkHostRef['state'] {
  return raw === 'online' || raw === 'idle' || raw === 'stale' || raw === 'offline'
    ? raw
    : 'offline';
}

/**
 * `ClientWorkSkill` → `WorkSkillRef`.
 *
 * GAP — `capabilities`: a skill's requested capabilities live on its *version*
 * (`WorkSkillVersion.contract`), behind `GET /api/work/skills/[id]/versions`,
 * one request per skill. The list is reported with an empty capability set
 * rather than N extra round trips on every composer open; the contract's own
 * rule — a skill can never widen what the run already had — means an empty list
 * understates rather than overstates what it may do.
 */
export function toWorkSkillRef(wire: WireSkill): WorkSkillRef {
  return {
    slug: wire.slug,
    name: wire.name,
    summary: wire.description ?? '',
    version: String(wire.currentVersion),
    capabilities: [],
  };
}

/**
 * `/api/connectors` → `WorkConnectorRef`.
 *
 * GAP — `scopes`: the route publishes a human `capability` sentence and no OAuth
 * scope list. Reported as empty rather than as a parse of that sentence.
 *
 * `healthy` is `configured && connected`: a connector the deployment has not
 * been given credentials for, and one the account has not linked, both fail the
 * same way at run time, and each gets its own sentence in `unhealthyReason`.
 */
export function toWorkConnectorRef(wire: WireConnector): WorkConnectorRef {
  const healthy = wire.configured && wire.connected;
  return {
    id: wire.id,
    name: wire.label,
    provider: wire.kind,
    healthy,
    unhealthyReason: healthy
      ? null
      : !wire.configured
        ? 'This deployment of Juno is not set up for this app.'
        : 'Your account has not connected this app yet.',
    scopes: [],
  };
}

/** Only linked connectors may be offered to a task. */
export function connectorIsOfferable(wire: WireConnector): boolean {
  return wire.connected;
}

/**
 * `/api/models` → the composer's model list.
 *
 * GAP — this is the general chat catalog. `workModelOptions` in
 * `src/lib/work/models.ts` is the Work-capable subset and no route publishes it,
 * so the composer is offered the account's whole catalog and the create route's
 * own plan gate is what refuses one it may not use. That refusal is a 403 with a
 * sentence, which is a worse moment to find out than a greyed row, and it is the
 * only mechanism there is.
 */
export function toWorkModelOption(wire: WireModel): { id: string; label: string; available: boolean } {
  return {
    id: wire.id,
    label: wire.label ?? wire.name ?? wire.id,
    available: wire.locked === true || wire.comingSoon === true ? false : (wire.available ?? true),
  };
}

/**
 * The task's file grants, from its context.
 *
 * Only cloud-file attachments appear: `readWorkSessionContext` filters to
 * `kind: "cloud_file"`, because a folder on a Mac is granted and revoked through
 * the host screen and only the Mac can resolve or release its bookmark.
 *
 * GAP — `createdAt`: the context route returns an id and a display name and no
 * timestamp. Empty rather than backfilled from the session, which would be a
 * date nothing recorded; an empty string is visibly not a date, and the UI
 * shows a grant by its label rather than by when it was made.
 */
export function toWorkGrants(context: WireSessionContext): WorkGrant[] {
  return context.attachments.map((attachment) => ({
    id: attachment.id,
    kind: 'cloud_file' as const,
    label: attachment.displayName,
    accessMode: 'read' as const,
    createdAt: '',
  }));
}

/** Whether the status vocabulary says this status demands the reader. */
export function statusDemandsAttention(raw: string): boolean {
  const known = coerce(WORK_STATUSES, raw, 'draft');
  return known === raw ? statusNeedsAttention(known) : false;
}

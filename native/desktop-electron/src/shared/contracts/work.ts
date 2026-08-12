/**
 * The Work IPC contract — STAGED FOR MERGE INTO `src/shared/ipc.ts`.
 *
 * `src/shared/ipc.ts` has no Work channels. This file declares exactly what the
 * Work surface needs, in that file's own idiom (a `{ request, response }` table
 * for invoke, a bare schema per event channel), so the merge is a copy rather
 * than a translation. Nothing outside `products/work` is edited to add it.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY ONE OF THESE IS A CHANNEL AND NOT A FETCH
 *
 * The renderer has no network. CSP is `connect-src 'self'` and the backend
 * sends no CORS headers, so a `fetch` from here fails twice over. Main holds the
 * Keychain credential and is the only process that can talk to `/api/work/*`.
 *
 * WHY THERE IS A POLLING CHANNEL AND NOT A SUBSCRIPTION
 *
 * Work is **not in the account change feed**. `src/main/sync/types.ts` names the
 * 22 entity types the server's change-capture triggers emit, and no `work_*`
 * type is among them — Work, Knowledge, Research and Import are all absent. So
 * there is no path by which a Work state change reaches this app on its own.
 * Main has to ask, on an interval, and the interval is a fact the user is
 * entitled to see. `work:poll-state` exists to carry that fact to the UI, and
 * the UI renders freshness from it rather than implying a liveness it does not
 * have. If a Work SSE relay is added in main later, this channel is still the
 * right shape — it just reports a much smaller age.
 *
 * ---------------------------------------------------------------------------
 * BUNDLE NOTE
 *
 * Components import *types* from this module and never values, and
 * `verbatimModuleSyntax` erases type-only imports outright, so Zod does not
 * reach the renderer bundle through this file. Runtime vocabulary lives in
 * `./lib/vocabulary.ts`, which has no dependencies at all; the schemas below
 * build their enums from it so the two cannot drift.
 */

import { z } from 'zod';
import {
  WORK_ACCESS_MODES,
  WORK_ACTORS,
  WORK_APPROVAL_ANSWERS,
  WORK_APPROVAL_DECISIONS,
  WORK_APPROVAL_REFUSALS,
  WORK_ARTIFACT_KINDS,
  WORK_AUDIT_KINDS,
  WORK_AUDIT_SEVERITIES,
  WORK_CAPABILITIES,
  WORK_DEGRADATION_KINDS,
  WORK_GRANT_KINDS,
  WORK_HOST_STATES,
  WORK_PERMISSION_POLICIES,
  WORK_PLAN_STEP_STATUSES,
  WORK_RISK_LEVELS,
  WORK_SENSITIVITIES,
  WORK_SOURCE_KINDS,
  WORK_STATUSES,
  WORK_TARGETS,
  WORK_TERMINAL_REASONS,
  WORK_TOOL_TIER_IDS,
} from './work-vocabulary.js';

/* -------------------------------------------------------------------------- */
/* Vocabulary schemas                                                          */
/* -------------------------------------------------------------------------- */

export const WorkStatusSchema = z.enum(WORK_STATUSES);
export const WorkTerminalReasonSchema = z.enum(WORK_TERMINAL_REASONS);
export const WorkTargetSchema = z.enum(WORK_TARGETS);
export const WorkCapabilitySchema = z.enum(WORK_CAPABILITIES);
export const WorkPermissionPolicySchema = z.enum(WORK_PERMISSION_POLICIES);
export const WorkRiskLevelSchema = z.enum(WORK_RISK_LEVELS);
export const WorkApprovalDecisionSchema = z.enum(WORK_APPROVAL_DECISIONS);
export const WorkApprovalAnswerSchema = z.enum(WORK_APPROVAL_ANSWERS);
export const WorkApprovalRefusalSchema = z.enum(WORK_APPROVAL_REFUSALS);
export const WorkPlanStepStatusSchema = z.enum(WORK_PLAN_STEP_STATUSES);
export const WorkToolTierIdSchema = z.enum(WORK_TOOL_TIER_IDS);
export const WorkArtifactKindSchema = z.enum(WORK_ARTIFACT_KINDS);
export const WorkGrantKindSchema = z.enum(WORK_GRANT_KINDS);
export const WorkAccessModeSchema = z.enum(WORK_ACCESS_MODES);
export const WorkDegradationKindSchema = z.enum(WORK_DEGRADATION_KINDS);
export const WorkHostStateSchema = z.enum(WORK_HOST_STATES);
export const WorkAuditKindSchema = z.enum(WORK_AUDIT_KINDS);
export const WorkAuditSeveritySchema = z.enum(WORK_AUDIT_SEVERITIES);
export const WorkActorSchema = z.enum(WORK_ACTORS);
export const WorkSensitivitySchema = z.enum(WORK_SENSITIVITIES);
export const WorkSourceKindSchema = z.enum(WORK_SOURCE_KINDS);

/** Typed detail bags. Kept `unknown` at the leaf: the UI narrows what it draws. */
const DetailBagSchema = z.record(z.string(), z.unknown());
/** Audit detail is restricted at the writer, and restricted again here. */
const AuditDetailSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

/* -------------------------------------------------------------------------- */
/* Entities                                                                    */
/* -------------------------------------------------------------------------- */

/** Mirrors `WorkBudget` — zero means "no explicit ceiling". */
export const WorkBudgetSchema = z.object({
  maxCostMicroUsd: z.number(),
  maxTokens: z.number(),
  maxRuntimeMs: z.number(),
});

/** Mirrors `BudgetUsage`. */
export const WorkUsageSchema = z.object({
  costMicroUsd: z.number(),
  tokens: z.number(),
  runtimeMs: z.number(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
});

export const WorkProvenanceSchema = z.object({
  source: z.string(),
  sourceKind: WorkSourceKindSchema,
  action: z.string(),
  trust: z.enum(['trusted', 'untrusted']),
});

export const WorkPlanStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: WorkPlanStepStatusSchema,
  reason: z.string().optional(),
});

export const WorkPlanSnapshotSchema = z.object({
  version: z.number(),
  steps: z.array(WorkPlanStepSchema),
});

export const WorkPlanDiffSchema = z.object({
  fromVersion: z.number(),
  toVersion: z.number(),
  added: z.array(WorkPlanStepSchema),
  removed: z.array(WorkPlanStepSchema),
  retitled: z.array(z.object({ id: z.string(), from: z.string(), to: z.string() })),
  statusChanged: z.array(
    z.object({
      id: z.string(),
      from: WorkPlanStepStatusSchema,
      to: WorkPlanStepStatusSchema,
      reason: z.string().optional(),
    }),
  ),
  reordered: z.boolean(),
  unchanged: z.number(),
});

export const WorkQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  /** Why the run cannot proceed without it. The user is owed this. */
  why: z.string(),
  options: z.array(z.string()).optional(),
});

/**
 * Mirrors `WorkApprovalRequest`, plus the two fields the *row* carries that the
 * runtime event does not: its current decision and when it was decided. A card
 * has to be able to draw itself after the fact.
 */
export const WorkApprovalSchema = z.object({
  id: z.string(),
  callId: z.string(),
  action: z.string(),
  tool: z.string(),
  risk: WorkRiskLevelSchema,
  summary: z.string(),
  detail: DetailBagSchema,
  /** The exact bytes `actionDigest` was taken over. Round-tripped, never shown. */
  digestInput: z.string(),
  actionDigest: z.string(),
  policyDigest: z.string(),
  expiresAt: z.string(),
  decision: WorkApprovalDecisionSchema,
  decidedAt: z.string().nullable(),
});

export const WorkArtifactRefSchema = z.object({
  id: z.string(),
  kind: WorkArtifactKindSchema,
  title: z.string(),
  version: z.number(),
  byteSize: z.number(),
});

export const WorkCitationSchema = z.object({
  title: z.string(),
  source: z.string(),
  retrievedAt: z.string(),
  quote: z.string().optional(),
});

export const WorkDecisionSchema = z.object({
  summary: z.string(),
  because: z.string(),
  alternatives: z.array(z.string()).optional(),
});

export const WorkActionRecordSchema = z.object({
  callId: z.string(),
  tool: z.string(),
  intent: z.string(),
  provenance: WorkProvenanceSchema,
  isError: z.boolean(),
  at: z.string(),
});

export const WorkValidationCheckSchema = z.object({
  claim: z.string(),
  satisfied: z.boolean(),
  evidence: z.string(),
});

export const WorkValidationResultSchema = z.object({
  satisfied: z.boolean(),
  checks: z.array(WorkValidationCheckSchema),
  unmet: z.array(z.string()),
  /**
   * Falsy by default and deliberately so: a validator that does not say it
   * compared the deliverable to the goal is treated as not having judged, and
   * the UI must not print the stronger sentence.
   */
  judged: z.boolean().optional(),
});

export const WorkReportSchema = z.object({
  goal: z.string(),
  plan: WorkPlanSnapshotSchema,
  actions: z.array(WorkActionRecordSchema),
  citations: z.array(WorkCitationSchema),
  decisions: z.array(WorkDecisionSchema),
  uncertainties: z.array(z.string()),
  verification: WorkValidationResultSchema,
  artifacts: z.array(WorkArtifactRefSchema),
  answer: z.string(),
});

export const WorkInjectionSummarySchema = z.object({
  detected: z.boolean(),
  severity: z.enum(['none', 'suspicious', 'hostile']),
  signals: z.array(
    z.enum([
      'assistant_directive',
      'system_prompt_probe',
      'tool_invocation_syntax',
      'credential_exfiltration',
      'encoded_payload',
      'envelope_escape',
    ]),
  ),
  matchCount: z.number(),
});

/* -------------------------------------------------------------------------- */
/* The event log                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The append-only log, discriminated on `kind`.
 *
 * All 31 kinds in `WORK_EVENT_KINDS` are represented. A kind with no variant
 * here is a kind the reducer silently drops, and the drop is invisible — which
 * is exactly the failure mode the closed vocabulary exists to prevent.
 */
export const WorkEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('run_started'), runId: z.string(), goal: z.string(), model: z.string() }),
  z.object({ kind: z.literal('plan_created'), plan: WorkPlanSnapshotSchema }),
  z.object({ kind: z.literal('plan_updated'), plan: WorkPlanSnapshotSchema, diff: WorkPlanDiffSchema }),
  z.object({ kind: z.literal('step_started'), stepId: z.string(), title: z.string() }),
  z.object({
    kind: z.literal('step_finished'),
    stepId: z.string(),
    title: z.string(),
    status: WorkPlanStepStatusSchema,
    reason: z.string().optional(),
  }),
  z.object({ kind: z.literal('assistant_message'), text: z.string() }),
  z.object({
    kind: z.literal('tool_started'),
    callId: z.string(),
    tool: z.string(),
    intent: z.string(),
    tier: WorkToolTierIdSchema,
    risk: WorkRiskLevelSchema,
    summary: z.string(),
    provenance: WorkProvenanceSchema,
  }),
  z.object({
    kind: z.literal('tool_finished'),
    callId: z.string(),
    tool: z.string(),
    isError: z.boolean(),
    durationMs: z.number(),
    provenance: WorkProvenanceSchema,
    injection: WorkInjectionSummarySchema.optional(),
  }),
  z.object({ kind: z.literal('tool_denied'), callId: z.string(), tool: z.string(), reason: z.string() }),
  z.object({ kind: z.literal('question_asked'), question: WorkQuestionSchema }),
  z.object({ kind: z.literal('question_answered'), questionId: z.string(), answer: z.string() }),
  /** Steering: an instruction the run never asked for. */
  z.object({ kind: z.literal('user_message'), text: z.string(), consumed: z.boolean() }),
  z.object({ kind: z.literal('approval_requested'), request: WorkApprovalSchema }),
  z.object({
    kind: z.literal('approval_resolved'),
    requestId: z.string(),
    decision: WorkApprovalDecisionSchema,
  }),
  z.object({ kind: z.literal('artifact_created'), artifact: WorkArtifactRefSchema }),
  z.object({ kind: z.literal('artifact_updated'), artifact: WorkArtifactRefSchema }),
  z.object({ kind: z.literal('source_cited'), citation: WorkCitationSchema }),
  z.object({
    kind: z.literal('files_changed'),
    /** Grant-relative labels. Never an absolute local path — this reaches a phone. */
    paths: z.array(z.string()),
    added: z.number(),
    modified: z.number(),
    removed: z.number(),
  }),
  z.object({
    kind: z.literal('batch_preview'),
    batchId: z.string(),
    summary: z.string(),
    itemCount: z.number(),
  }),
  z.object({ kind: z.literal('batch_applied'), batchId: z.string(), itemCount: z.number() }),
  z.object({ kind: z.literal('batch_undone'), batchId: z.string(), itemCount: z.number() }),
  z.object({
    kind: z.literal('subagent_update'),
    agentId: z.string(),
    label: z.string(),
    status: z.string(),
  }),
  z.object({
    kind: z.literal('degraded'),
    degradation: WorkDegradationKindSchema,
    detail: z.string(),
  }),
  z.object({
    kind: z.literal('budget_warning'),
    limit: z.enum(['cost', 'tokens', 'runtime']),
    detail: z.string(),
  }),
  z.object({ kind: z.literal('host_disconnected'), hostId: z.string(), detail: z.string() }),
  z.object({ kind: z.literal('host_reconnected'), hostId: z.string() }),
  z.object({ kind: z.literal('paused'), reason: z.string() }),
  z.object({ kind: z.literal('resumed') }),
  z.object({ kind: z.literal('validation_result'), result: WorkValidationResultSchema }),
  z.object({
    kind: z.literal('run_finished'),
    terminalReason: WorkTerminalReasonSchema,
    detail: z.string(),
    usage: WorkUsageSchema,
    report: WorkReportSchema,
  }),
  z.object({ kind: z.literal('error'), message: z.string() }),
]);

/** `seq` is the cursor clients resume from; `at` is stamped by the session. */
export const WorkEmittedEventSchema = z.intersection(
  WorkEventSchema,
  z.object({ seq: z.number(), at: z.string() }),
);

/* -------------------------------------------------------------------------- */
/* Sessions, runs, grants, audit                                               */
/* -------------------------------------------------------------------------- */

export const WorkGrantSchema = z.object({
  id: z.string(),
  kind: WorkGrantKindSchema,
  /** Display label. Grant-relative; never an absolute path. */
  label: z.string(),
  accessMode: WorkAccessModeSchema,
  createdAt: z.string(),
});

export const WorkConnectorRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  healthy: z.boolean(),
  /** Why an unhealthy connector is unhealthy, when the server says. */
  unhealthyReason: z.string().nullable(),
  scopes: z.array(z.string()),
});

export const WorkSkillRefSchema = z.object({
  slug: z.string(),
  name: z.string(),
  summary: z.string(),
  version: z.string(),
  /** Capabilities the skill asks for. It can never widen what the run already had. */
  capabilities: z.array(WorkCapabilitySchema),
});

export const WorkHostRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: WorkHostStateSchema,
  lastSeenAt: z.string().nullable(),
  /** What this Mac has actually advertised. Nothing is assumed about a host. */
  capabilities: z.array(WorkCapabilitySchema),
  /** A Mac may narrow the policy further; it may never widen it. */
  maxPermissionPolicy: WorkPermissionPolicySchema,
});

/** `WorkSession` — the task. */
export const WorkSessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Written once, deliberately un-stripped of any `/slug`. It is what you wrote. */
  goal: z.string(),
  status: WorkStatusSchema,
  target: WorkTargetSchema,
  permissionPolicy: WorkPermissionPolicySchema,
  model: z.string().nullable(),
  sensitivity: WorkSensitivitySchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  attempts: z.number(),
  pinned: z.boolean(),
  archived: z.boolean(),
  latestRunId: z.string().nullable(),
  grants: z.array(WorkGrantSchema),
  connectors: z.array(WorkConnectorRefSchema),
  skill: WorkSkillRefSchema.nullable(),
  /** Set when the session came from, or is linked to, a conversation. */
  conversationId: z.string().nullable(),
});

/** `WorkRun` — one attempt at the task. The run, never the session, is claimed. */
export const WorkRunSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  attempt: z.number(),
  status: WorkStatusSchema,
  /** The resolved target. `automatic` never survives dispatch. */
  target: z.enum(['cloud', 'local']),
  hostId: z.string().nullable(),
  model: z.string(),
  permissionPolicy: WorkPermissionPolicySchema,
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  terminalReason: WorkTerminalReasonSchema.nullable(),
  terminalDetail: z.string().nullable(),
  usage: WorkUsageSchema,
  budget: WorkBudgetSchema,
  /** Highest `seq` written for this run. The poll cursor. */
  lastSeq: z.number(),
});

export const WorkSessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  goal: z.string(),
  status: WorkStatusSchema,
  updatedAt: z.string(),
  attempts: z.number(),
  pinned: z.boolean(),
  archived: z.boolean(),
  /** Transcribed from the status vocabulary by the server, not guessed here. */
  needsAttention: z.boolean(),
  /** Non-null only when the run is stopped on a question or an approval. */
  openRequestSummary: z.string().nullable(),
});

export const WorkAuditEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  kind: WorkAuditKindSchema,
  severity: WorkAuditSeveritySchema,
  actor: WorkActorSchema,
  runId: z.string().nullable(),
  detail: AuditDetailSchema,
});

/* -------------------------------------------------------------------------- */
/* Freshness — the honest half of a product with no realtime feed              */
/* -------------------------------------------------------------------------- */

/**
 * What main's poller is actually doing, as a fact rather than an animation.
 *
 * Every field here exists because the UI makes a claim that would otherwise be
 * a guess: how old the state is (`lastSucceededAt`), whether a refresh is in
 * flight (`phase`), when the next one lands (`nextAttemptAt`), whether the
 * failure is this app's or the network's (`online`, `error`), and how far behind
 * the log the client is (`cursorSeq`).
 */
export const WorkPollStateSchema = z.object({
  /** Which session this poller is attached to; null when nothing is open. */
  sessionId: z.string().nullable(),
  phase: z.enum(['idle', 'polling', 'ok', 'failed', 'suspended']),
  /** The current interval. Main backs off on failure and on terminal runs. */
  intervalMs: z.number(),
  lastSucceededAt: z.string().nullable(),
  lastAttemptedAt: z.string().nullable(),
  nextAttemptAt: z.string().nullable(),
  consecutiveFailures: z.number(),
  /** Main's own reachability verdict for the backend. */
  online: z.boolean(),
  error: z.string().nullable(),
  /** The highest `seq` this client has. */
  cursorSeq: z.number(),
});

/**
 * One poll's worth of truth about a task.
 *
 * `events` is a *delta* when `sinceSeq` was supplied and a full replay
 * otherwise; `replaced` says which, so the reducer never appends a replay onto
 * a log it already has.
 */
export const WorkSnapshotSchema = z.object({
  session: WorkSessionSchema,
  run: WorkRunSchema.nullable(),
  events: z.array(WorkEmittedEventSchema),
  replaced: z.boolean(),
  approvals: z.array(WorkApprovalSchema),
  /** Open questions, matched by id — two can be open at once. */
  questions: z.array(WorkQuestionSchema),
  /** When main received this from the server, not when it rendered. */
  fetchedAt: z.string(),
});

/* -------------------------------------------------------------------------- */
/* Composer inputs                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What the composer may offer. Everything here is server truth: a connector the
 * account does not have is not a connector the composer may draw as available.
 */
export const WorkCapabilitiesSnapshotSchema = z.object({
  connectors: z.array(WorkConnectorRefSchema),
  skills: z.array(WorkSkillRefSchema),
  hosts: z.array(WorkHostRefSchema),
  /** Cloud-side capabilities available to this account right now. */
  cloudCapabilities: z.array(WorkCapabilitySchema),
  /** `DEFAULT_RUN_BUDGET` as the server has it. Never hard-coded in the UI. */
  defaultBudget: WorkBudgetSchema,
  models: z.array(z.object({ id: z.string(), label: z.string(), available: z.boolean() })),
  fetchedAt: z.string(),
});

/** A grant the user picked through a native dialog in main. */
export const WorkGrantCandidateSchema = z.object({
  kind: WorkGrantKindSchema,
  label: z.string(),
  /** Opaque to the renderer: main holds the path, the renderer holds the token. */
  token: z.string(),
  accessMode: WorkAccessModeSchema,
});

const OkSchema = z.object({ ok: z.literal(true) });

/* -------------------------------------------------------------------------- */
/* Invoke channels                                                             */
/* -------------------------------------------------------------------------- */

export const WORK_INVOKE_CHANNELS = {
  /** The task list. Polled, like everything else here. */
  'work:list-tasks': {
    request: z.object({
      filter: z.enum(['active', 'needs-attention', 'all', 'archived']),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    response: z.object({
      tasks: z.array(WorkSessionSummarySchema),
      fetchedAt: z.string(),
    }),
  },

  /**
   * One task's full state. `sinceSeq` asks for a delta; omitting it asks for a
   * replay and sets `replaced` on the answer.
   */
  'work:task-snapshot': {
    request: z.object({ sessionId: z.string(), sinceSeq: z.number().optional() }),
    response: WorkSnapshotSchema,
  },

  /**
   * Attach main's poller to a session, or detach it (`sessionId: null`).
   *
   * Explicit rather than implied by `work:task-snapshot` because the poller is a
   * resource with a lifetime: exactly one session is polled at a time, and the
   * renderer navigating away has to be able to say so.
   */
  'work:watch-task': {
    request: z.object({ sessionId: z.string().nullable() }),
    response: WorkPollStateSchema,
  },

  /** Refresh now, out of band. Resets the interval; never queues behind it. */
  'work:poll-now': {
    request: z.object({ sessionId: z.string() }),
    response: WorkPollStateSchema,
  },

  /**
   * Create a task in `draft`. Goal, files, connectors and skill are fixed at
   * dispatch, so this is where they are chosen and there is no edit channel.
   */
  'work:create-task': {
    request: z.object({
      goal: z.string().min(1),
      title: z.string().optional(),
      target: WorkTargetSchema,
      permissionPolicy: WorkPermissionPolicySchema,
      model: z.string().nullable(),
      connectorIds: z.array(z.string()),
      grantTokens: z.array(z.string()),
      skillSlug: z.string().nullable(),
    }),
    response: z.object({ sessionId: z.string() }),
  },

  /**
   * Dispatch an attempt. The three overrides are attempt-scoped: they bind when
   * the loop is constructed and do not edit the session.
   */
  'work:dispatch-run': {
    request: z.object({
      sessionId: z.string(),
      target: WorkTargetSchema.optional(),
      permissionPolicy: WorkPermissionPolicySchema.optional(),
      model: z.string().optional(),
    }),
    response: z.object({ runId: z.string(), attempt: z.number() }),
  },

  /** `POST /api/work/runs/[id]/control`. */
  'work:control-run': {
    request: z.object({ runId: z.string(), action: z.enum(['pause', 'resume', 'cancel']) }),
    response: z.object({ ok: z.literal(true), status: WorkStatusSchema }),
  },

  /**
   * `POST /api/work/sessions/[id]/answer`.
   *
   * With `questionId` it answers that question; without, it records steering —
   * an instruction the run never asked for. One channel because it is one route,
   * and because the distinction is exactly one optional field.
   */
  'work:answer': {
    request: z.object({
      sessionId: z.string(),
      questionId: z.string().nullable(),
      text: z.string().min(1),
    }),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), kind: z.enum(['question_answered', 'user_message']) }),
      /** A `waiting_input` run refuses steering: it is stopped, and saying otherwise would lie. */
      z.object({ ok: z.literal(false), reason: z.enum(['waiting_input', 'not_live', 'unknown_question']) }),
    ]),
  },

  /**
   * `POST /api/work/approvals/[id]/decision`.
   *
   * `actionDigest` is echoed so the server can prove the card that was drawn is
   * the row being answered, and the five refusals come back named rather than as
   * one error — each has its own sentence and its own next move.
   */
  'work:resolve-approval': {
    request: z.object({
      approvalId: z.string(),
      decision: WorkApprovalAnswerSchema,
      actionDigest: z.string(),
    }),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), decision: WorkApprovalDecisionSchema }),
      z.object({ ok: z.literal(false), refusal: WorkApprovalRefusalSchema, detail: z.string() }),
    ]),
  },

  /** The security log for one task. Separate table, separate route, separate channel. */
  'work:audit-trail': {
    request: z.object({ sessionId: z.string(), limit: z.number().int().min(1).max(500).optional() }),
    response: z.object({ entries: z.array(WorkAuditEntrySchema), fetchedAt: z.string() }),
  },

  /** What the composer may offer. */
  'work:capabilities': { request: z.void(), response: WorkCapabilitiesSnapshotSchema },

  /**
   * A native folder/file picker in main.
   *
   * The renderer cannot name an arbitrary path and have it granted — the same
   * rule `workspace:choose` follows, and the reason the grant prompt means
   * anything.
   */
  'work:choose-grant': {
    request: z.object({ kind: z.enum(['local_folder', 'local_file']), accessMode: WorkAccessModeSchema }),
    response: WorkGrantCandidateSchema.nullable(),
  },

  /** Download and reveal an artifact. Bytes never enter the renderer. */
  'work:open-artifact': {
    request: z.object({ artifactId: z.string(), version: z.number(), reveal: z.boolean() }),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), filename: z.string() }),
      z.object({ ok: z.literal(false), reason: z.string() }),
    ]),
  },

  /** Open a linked conversation in the Chat surface. */
  'work:open-conversation': {
    request: z.object({ conversationId: z.string() }),
    response: OkSchema,
  },
} as const satisfies Record<string, { request: z.ZodType; response: z.ZodType }>;

export type WorkInvokeChannel = keyof typeof WORK_INVOKE_CHANNELS;
export type WorkInvokeRequest<C extends WorkInvokeChannel> = z.infer<
  (typeof WORK_INVOKE_CHANNELS)[C]['request']
>;
export type WorkInvokeResponse<C extends WorkInvokeChannel> = z.infer<
  (typeof WORK_INVOKE_CHANNELS)[C]['response']
>;

/* -------------------------------------------------------------------------- */
/* Event channels                                                              */
/* -------------------------------------------------------------------------- */

export const WORK_EVENT_CHANNELS = {
  /** A poll landed. Carries the delta and the `fetchedAt` the UI ages from. */
  'work:snapshot': WorkSnapshotSchema,
  /** The task list, refreshed on its own slower interval. */
  'work:tasks': z.object({ tasks: z.array(WorkSessionSummarySchema), fetchedAt: z.string() }),
  /**
   * The poller talking about itself. This is the channel that makes staleness
   * renderable instead of imaginary, and it fires on every attempt — including
   * the ones that fail, which are the ones that matter.
   */
  'work:poll-state': WorkPollStateSchema,
} as const satisfies Record<string, z.ZodType>;

export type WorkEventChannel = keyof typeof WORK_EVENT_CHANNELS;
export type WorkEventPayload<C extends WorkEventChannel> = z.infer<
  (typeof WORK_EVENT_CHANNELS)[C]
>;

/* -------------------------------------------------------------------------- */
/* Inferred entity types — what components import                              */
/* -------------------------------------------------------------------------- */

export type WorkBudget = z.infer<typeof WorkBudgetSchema>;
export type WorkUsage = z.infer<typeof WorkUsageSchema>;
export type WorkProvenance = z.infer<typeof WorkProvenanceSchema>;
export type WorkPlanStep = z.infer<typeof WorkPlanStepSchema>;
export type WorkPlanSnapshot = z.infer<typeof WorkPlanSnapshotSchema>;
export type WorkPlanDiff = z.infer<typeof WorkPlanDiffSchema>;
export type WorkQuestion = z.infer<typeof WorkQuestionSchema>;
export type WorkApproval = z.infer<typeof WorkApprovalSchema>;
export type WorkArtifactRef = z.infer<typeof WorkArtifactRefSchema>;
export type WorkCitation = z.infer<typeof WorkCitationSchema>;
export type WorkDecisionRecord = z.infer<typeof WorkDecisionSchema>;
export type WorkActionRecord = z.infer<typeof WorkActionRecordSchema>;
export type WorkValidationCheck = z.infer<typeof WorkValidationCheckSchema>;
export type WorkValidationResult = z.infer<typeof WorkValidationResultSchema>;
export type WorkReport = z.infer<typeof WorkReportSchema>;
export type WorkInjectionSummary = z.infer<typeof WorkInjectionSummarySchema>;
export type WorkEvent = z.infer<typeof WorkEventSchema>;

/**
 * `WorkEvent` with the two fields the session stamps on it.
 *
 * Written as a distributed conditional rather than as `z.infer` of the
 * intersection above. `(A | B) & M` is an intersection whose left side happens
 * to be a union, and TypeScript is not obliged to normalise it into
 * `(A & M) | (B & M)` — where it does not, `switch (event.kind)` stops narrowing
 * and every branch sees the whole union. The event log is read by exactly one
 * exhaustive switch in `lib/derive.ts`, and that switch losing its narrowing
 * would be a silent loss of the compile-time guarantee that a newly added kind
 * gets handled.
 */
type WithLogMeta<T> = T extends unknown ? T & { seq: number; at: string } : never;
export type WorkEmittedEvent = WithLogMeta<WorkEvent>;
export type WorkGrant = z.infer<typeof WorkGrantSchema>;
export type WorkConnectorRef = z.infer<typeof WorkConnectorRefSchema>;
export type WorkSkillRef = z.infer<typeof WorkSkillRefSchema>;
export type WorkHostRef = z.infer<typeof WorkHostRefSchema>;
export type WorkSession = z.infer<typeof WorkSessionSchema>;
export type WorkRun = z.infer<typeof WorkRunSchema>;
export type WorkSessionSummary = z.infer<typeof WorkSessionSummarySchema>;
export type WorkAuditEntry = z.infer<typeof WorkAuditEntrySchema>;
export type WorkPollState = z.infer<typeof WorkPollStateSchema>;
export type WorkSnapshot = z.infer<typeof WorkSnapshotSchema>;
export type WorkCapabilitiesSnapshot = z.infer<typeof WorkCapabilitiesSnapshotSchema>;
export type WorkGrantCandidate = z.infer<typeof WorkGrantCandidateSchema>;

/** Narrow one variant of the event union by its `kind` tag. */
export type WorkEventOf<K extends WorkEvent['kind']> = Extract<WorkEmittedEvent, { kind: K }>;

/**
 * The vocabulary a Juno Work run speaks: its events, its plan, its tool
 * intents, and the provenance it records for everything it touches.
 *
 * The Code-shaped `AgentSession` in agent.ts answers one question — what
 * happened in this turn — and its event union is sized for that. A Work run
 * answers a different one, months later: what was the goal, what plan was
 * shown to the user, which tool touched which source under whose permission,
 * what was cited, what was uncertain, and what evidence says the deliverable
 * actually answers the goal. Those fields have no home in `AgentEvent`, so
 * they get their own union here rather than a `metadata` bag on the old one.
 *
 * This module is the Work half of the leaf layer: it imports two types from
 * the core and nothing else, so plan, tier, budget, injection and session can
 * all depend on it without depending on each other.
 */

import type { Usage } from '../types.js';
import type { ToolDefinition } from '../tools/types.js';

// ---------------------------------------------------------------------------
// Mirrored from src/lib/work/domain.ts
// ---------------------------------------------------------------------------

/*
 * Everything between here and the end of this section is a copy of
 * src/lib/work/domain.ts, not an independent implementation of it.
 *
 * runner/agent-core is vendored: it has its own tsconfig, is built on its own
 * in CI (`npm i && npm run build` inside this directory, with the rest of the
 * repository absent from the image), and ships as a standalone package. The
 * `@/` path alias that would resolve `@/lib/work/domain` is declared by the
 * app's tsconfig and points into a tree the runner build never sees, so an
 * import of it compiles nowhere the runner is actually built. A relative
 * `../../../../src/lib/work/domain.js` would resolve in this checkout and
 * break the moment the package is consumed the way package.json says it is.
 *
 * So: copy, deliberately, and keep it byte-identical. domain.ts stays the
 * source of truth — scripts/generate-work-contract.mjs generates the Swift
 * clients from it, and a value invented here would be a value no client can
 * name. When domain.ts changes, this block is re-copied; nothing here is
 * edited in place.
 */

export const WORK_EVENT_KINDS = [
  'run_started',
  'plan_created',
  'plan_updated',
  'step_started',
  'step_finished',
  'assistant_message',
  'tool_started',
  'tool_finished',
  'tool_denied',
  'question_asked',
  'question_answered',
  'approval_requested',
  'approval_resolved',
  'artifact_created',
  'artifact_updated',
  'source_cited',
  'files_changed',
  'batch_preview',
  'batch_applied',
  'batch_undone',
  'subagent_update',
  'degraded',
  'budget_warning',
  'host_disconnected',
  'host_reconnected',
  'paused',
  'resumed',
  'validation_result',
  'run_finished',
  'error',
] as const;

export type WorkEventKind = (typeof WORK_EVENT_KINDS)[number];

export const WORK_RISK_LEVELS = ['safe', 'edit', 'command', 'sensitive', 'irreversible'] as const;

export type WorkRiskLevel = (typeof WORK_RISK_LEVELS)[number];

export const WORK_TERMINAL_REASONS = [
  'completed',
  'failed',
  'cancelled',
  'budget_exceeded',
  'timed_out',
  'host_offline',
  'interrupted',
  'superseded',
] as const;

export type WorkTerminalReason = (typeof WORK_TERMINAL_REASONS)[number];

export const WORK_APPROVAL_DECISIONS = [
  'pending',
  'allowed',
  'allowed_always',
  'denied',
  'expired',
  'superseded',
] as const;

export type WorkApprovalDecision = (typeof WORK_APPROVAL_DECISIONS)[number];

/** How long an approval request stays answerable. */
export const APPROVAL_TTL_MS = 15 * 60 * 1000;

export const ALWAYS_CONFIRM_ACTIONS: readonly string[] = [
  'work.file.permanent_delete',
  'work.file.empty_trash',
  'work.app.purchase',
  'work.browser.purchase',
  'work.connector.send_message',
  'work.connector.publish',
  'work.connector.delete',
  'work.connector.payment',
  'work.system.change_security_setting',
  'work.system.change_account_setting',
];

const ALWAYS_CONFIRM = new Set(ALWAYS_CONFIRM_ACTIONS);

/**
 * The floor: what asks under every mode, including Skip.
 *
 * Deliberately takes no policy. This is the answer no setting in the product
 * changes, and giving it a policy argument would be the first step towards a
 * mode that turns it off.
 */
export function requiresExplicitApproval(action: string, risk: WorkRiskLevel): boolean {
  return ALWAYS_CONFIRM.has(action) || risk === 'sensitive' || risk === 'irreversible';
}

/**
 * The approval modes, mirrored from `src/lib/work/domain.ts`.
 *
 * Hand-copied because this package is vendored and built with the repository
 * absent — the same reason `ALWAYS_CONFIRM_ACTIONS` above is a copy.
 * `tests/work-security.test.ts` asserts the two do not drift.
 *
 * Manual = conservative, Auto = balanced, Skip = permissive. The wire values are
 * the stored ones and are not renamed: they are written on every existing
 * session row and hashed into every granted approval.
 */
export const WORK_PERMISSION_POLICIES = ['conservative', 'balanced', 'permissive'] as const;
export type WorkPermissionPolicy = (typeof WORK_PERMISSION_POLICIES)[number];

export function isWorkPermissionPolicy(value: unknown): value is WorkPermissionPolicy {
  return (WORK_PERMISSION_POLICIES as readonly unknown[]).includes(value);
}

/**
 * Whether this action, at this risk, has to be put to the user under this mode.
 *
 * The floor is checked first and separately, so no mode can reach past it. Only
 * once past the floor does the mode get a say, and all it decides is how much of
 * the *ordinary* work it waves through:
 *
 *   Manual  — reading proceeds; changing a file or running anything asks.
 *   Auto    — changes it can undo proceed; running anything asks.
 *   Skip    — everything the floor permits proceeds.
 *
 * Before this existed the three modes stopped for exactly the same actions:
 * the gate was `requiresExplicitApproval(action, risk)` with no policy, so the
 * setting was stored, advertised, narrowed against the Mac's own, hashed into
 * every approval — and read by nothing that could act on it.
 */
export function approvalAsksUnder(
  action: string,
  risk: WorkRiskLevel,
  policy: WorkPermissionPolicy
): boolean {
  if (requiresExplicitApproval(action, risk)) return true;
  switch (policy) {
    case 'conservative':
      return risk !== 'safe';
    case 'balanced':
      return risk !== 'safe' && risk !== 'edit';
    case 'permissive':
      return false;
  }
}

export const WORK_TOOL_TIERS = [
  { tier: 1, id: 'connector', label: 'Connected app' },
  { tier: 2, id: 'structured_file', label: 'File or document tool' },
  { tier: 3, id: 'browser_dom', label: 'Browser' },
  { tier: 4, id: 'accessibility', label: 'App accessibility' },
  { tier: 5, id: 'visual', label: 'Screen control' },
  { tier: 6, id: 'shell', label: 'Shell' },
] as const;

export type WorkToolTierId = (typeof WORK_TOOL_TIERS)[number]['id'];

const TIER_BY_ID = new Map<string, number>(WORK_TOOL_TIERS.map((t) => [t.id, t.tier]));

export function toolTier(id: string): number {
  return TIER_BY_ID.get(id) ?? Number.MAX_SAFE_INTEGER;
}

export function permitsTier(chosen: string, candidates: readonly string[]): boolean {
  const best = Math.min(...candidates.map(toolTier), Number.MAX_SAFE_INTEGER);
  return toolTier(chosen) <= best;
}

export const WORK_ARTIFACT_KINDS = [
  'document',
  'spreadsheet',
  'presentation',
  'pdf',
  'report',
  'bundle',
  'image',
  'site',
  'archive',
] as const;

export type WorkArtifactKind = (typeof WORK_ARTIFACT_KINDS)[number];

export const WORK_AUDIT_KINDS = [
  'grant_created',
  'grant_revoked',
  'host_enabled',
  'host_disabled',
  'host_revoked',
  'command_claimed',
  'command_refused',
  'approval_requested',
  'approval_decided',
  'approval_replay_refused',
  'policy_narrowed',
  'egress_blocked',
  'injection_detected',
  'path_escape_refused',
  'permanent_delete_requested',
  'screenshot_captured',
  'skill_applied',
  'tier_downgrade_refused',
] as const;

export type WorkAuditKind = (typeof WORK_AUDIT_KINDS)[number];

export const WORK_AUDIT_SEVERITIES = ['info', 'warning', 'refusal', 'violation'] as const;
export type WorkAuditSeverity = (typeof WORK_AUDIT_SEVERITIES)[number];

export interface WorkBudget {
  maxCostMicroUsd: number;
  maxTokens: number;
  maxRuntimeMs: number;
}

/** Zero means "no explicit ceiling"; the plan default applies instead. */
export const NO_BUDGET: WorkBudget = { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 0 };

export interface BudgetUsage {
  costMicroUsd: number;
  tokens: number;
  runtimeMs: number;
}

export function budgetExceeded(
  budget: WorkBudget,
  usage: BudgetUsage,
): { exceeded: false } | { exceeded: true; limit: 'cost' | 'tokens' | 'runtime'; detail: string } {
  if (budget.maxCostMicroUsd > 0 && usage.costMicroUsd >= budget.maxCostMicroUsd) {
    return {
      exceeded: true,
      limit: 'cost',
      detail: `Spent ${(usage.costMicroUsd / 1_000_000).toFixed(2)} of a ${(budget.maxCostMicroUsd / 1_000_000).toFixed(2)} USD ceiling.`,
    };
  }
  if (budget.maxTokens > 0 && usage.tokens >= budget.maxTokens) {
    return {
      exceeded: true,
      limit: 'tokens',
      detail: `Used ${usage.tokens} of ${budget.maxTokens} tokens.`,
    };
  }
  if (budget.maxRuntimeMs > 0 && usage.runtimeMs >= budget.maxRuntimeMs) {
    return {
      exceeded: true,
      limit: 'runtime',
      detail: `Ran for ${Math.round(usage.runtimeMs / 1000)}s of a ${Math.round(budget.maxRuntimeMs / 1000)}s ceiling.`,
    };
  }
  return { exceeded: false };
}

export function narrowestBudget(...budgets: readonly (WorkBudget | undefined | null)[]): WorkBudget {
  const pick = (get: (b: WorkBudget) => number) => {
    let best = 0;
    for (const budget of budgets) {
      if (!budget) continue;
      const value = get(budget);
      if (value <= 0) continue;
      best = best === 0 ? value : Math.min(best, value);
    }
    return best;
  };
  return {
    maxCostMicroUsd: pick((b) => b.maxCostMicroUsd),
    maxTokens: pick((b) => b.maxTokens),
    maxRuntimeMs: pick((b) => b.maxRuntimeMs),
  };
}

// ---------------------------------------------------------------------------
// Canonical serialisation
// ---------------------------------------------------------------------------

/**
 * A byte-stable rendering of a value, used wherever two parties have to agree
 * on what was said.
 *
 * Three call sites depend on it and all three break subtly without it: the
 * approval digest the executor recomputes before acting (key order out of
 * `JSON.stringify` follows insertion order, so the same action assembled by a
 * different code path digests differently and every approval is refused as a
 * replay), the repetition signature the plan uses to notice a loop (the same
 * call would otherwise look new), and the policy digest that pins an approval
 * to the policy in force when it was granted.
 *
 * Keys sort by UTF-16 code unit, never `localeCompare`, because a locale-aware
 * sort is a different order on a machine with a different ICU build and the
 * digest has to survive being recomputed on another host.
 */
export function canonicalJson(value: unknown): string {
  return encodeCanonical(value, new Set<object>());
}

function encodeCanonical(value: unknown, seen: Set<object>): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value !== 'object') return 'null';

  const object = value as object;
  // A cycle is a caller bug, but throwing here would turn it into a failed run
  // rather than a digest mismatch someone can read.
  if (seen.has(object)) return '"[circular]"';
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      return `[${object.map((entry) => encodeCanonical(entry, seen)).join(',')}]`;
    }
    const entries = Object.entries(object as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${encodeCanonical(entry, seen)}`)
      .join(',')}}`;
  } finally {
    seen.delete(object);
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export const WORK_PLAN_STEP_STATUSES = ['pending', 'active', 'done', 'skipped', 'failed'] as const;
export type WorkPlanStepStatus = (typeof WORK_PLAN_STEP_STATUSES)[number];

export interface WorkPlanStep {
  /** Stable across revisions. The UI keys its rows on this. */
  id: string;
  title: string;
  status: WorkPlanStepStatus;
  /**
   * Why a step was skipped or failed, in the user's language. Required for
   * those two statuses by the plan's API rather than by this type, because a
   * step that is greyed out with no explanation is the single most common way
   * a run looks like it succeeded when it did not.
   */
  reason?: string;
}

export interface WorkPlanSnapshot {
  version: number;
  steps: WorkPlanStep[];
}

/**
 * What changed between two versions of the plan.
 *
 * The alternative — hand the client a new list and let it re-render — loses
 * the only information the user actually wants at that moment, which is what
 * moved. It also makes the plan flicker, because a re-rendered list has no way
 * to say "these seven rows are the same seven rows".
 */
export interface WorkPlanDiff {
  fromVersion: number;
  toVersion: number;
  added: WorkPlanStep[];
  removed: WorkPlanStep[];
  retitled: Array<{ id: string; from: string; to: string }>;
  statusChanged: Array<{
    id: string;
    from: WorkPlanStepStatus;
    to: WorkPlanStepStatus;
    reason?: string;
  }>;
  /** True when the same ids came back in a different order. */
  reordered: boolean;
  /** Steps that survived untouched, as a count — the UI needs no more. */
  unchanged: number;
}

/**
 * Why the loop should stop even though nothing failed and no ceiling was hit.
 *
 * A run that has stopped making progress will happily spend its entire budget
 * proving it, and the user is then told the task cost the maximum and produced
 * nothing. Both states here exist to end that run early with a sentence that
 * says what actually happened.
 */
export type WorkProgressVerdict =
  | { state: 'progressing' }
  | { state: 'stalled'; reason: string; callsSinceProgress: number }
  | { state: 'repeating'; reason: string; tool: string; repetitions: number };

// ---------------------------------------------------------------------------
// Tools, intents and provenance
// ---------------------------------------------------------------------------

/**
 * One tool that has declared it can serve a given intent.
 *
 * `healthy` is what stops the hierarchy becoming a trap: a connector whose
 * token expired is still the highest tier for its intent, and refusing the
 * browser because of it would leave the run with no way to do the work at all.
 */
export interface WorkToolCandidate {
  tool: string;
  tier: WorkToolTierId;
  healthy: boolean;
  /** Shown to the user when an unhealthy top tier is why a lower one ran. */
  unhealthyReason?: string;
}

export interface WorkProvenance {
  /**
   * Where the data came from, as a stable identifier: a connector id, a URL, a
   * grant-relative display label. Never an absolute local path — this reaches
   * a phone.
   */
  source: string;
  sourceKind: 'connector' | 'web' | 'file' | 'local_app' | 'model' | 'user';
  /** The action identifier approvals and audit rows are keyed on. */
  action: string;
  /**
   * Whether the output of this call is text nobody in this conversation wrote.
   * Everything untrusted is scanned and enveloped; everything trusted is not.
   */
  trust: 'trusted' | 'untrusted';
}

/**
 * A tool as a Work run needs to see it.
 *
 * `ToolDefinition` describes what a tool does; this adds what a Work run has
 * to know before letting it run — which rung of the hierarchy it sits on, what
 * intent this particular call serves, what the action is called for approval
 * and audit, and where its output came from.
 */
export interface WorkToolDefinition extends ToolDefinition {
  tier: WorkToolTierId;
  /** Every intent this tool has declared it can serve. Used for candidacy. */
  intents: readonly string[];
  /** The one intent THIS call serves. Must be a member of `intents`. */
  intentFor(input: Record<string, unknown>): string;
  actionFor(input: Record<string, unknown>): string;
  riskFor(input: Record<string, unknown>): WorkRiskLevel;
  provenanceFor(input: Record<string, unknown>): WorkProvenance;
  /** Absent means always healthy. Consulted per call, never cached. */
  isHealthy?(): boolean;
}

// ---------------------------------------------------------------------------
// Questions, approvals, artifacts, citations
// ---------------------------------------------------------------------------

export interface WorkQuestion {
  id: string;
  /** One question, in plain language. */
  question: string;
  /** Why the run cannot proceed without it — the user is owed this. */
  why: string;
  /** Offered answers, when the answer is a choice rather than free text. */
  options?: string[];
}

/**
 * The four answers a client may give.
 *
 * `pending` and `superseded` are states the approval row passes through, never
 * things a person says, so they are excluded here: a callback that can return
 * `pending` is a callback whose caller has to handle a decision that is not a
 * decision.
 */
export type WorkApprovalAnswer = 'allowed' | 'allowed_always' | 'denied' | 'expired';

export interface WorkApprovalRequest {
  id: string;
  callId: string;
  /** e.g. "work.connector.send_message". */
  action: string;
  tool: string;
  risk: WorkRiskLevel;
  /** Exactly the sentence the user is shown. Stored so an audit can prove it. */
  summary: string;
  /** Typed detail for the UI: counts, display names, before/after. */
  detail: Record<string, unknown>;
  /**
   * The exact bytes `actionDigest` was taken over. Carried with the request so
   * the executor can recompute the digest at the moment of acting instead of
   * trusting the one it was handed — an approval that travelled through a
   * phone and back is otherwise indistinguishable from one an attacker
   * replayed against a different action.
   */
  digestInput: string;
  actionDigest: string;
  policyDigest: string;
  expiresAt: string;
}

export interface WorkArtifactRef {
  id: string;
  kind: WorkArtifactKind;
  title: string;
  /** Version number within the artifact, 1-based. */
  version: number;
  byteSize: number;
}

export interface WorkCitation {
  /** The page or record title as published, not as the model paraphrased it. */
  title: string;
  source: string;
  retrievedAt: string;
  /** The specific passage relied on, when there is one. */
  quote?: string;
}

// ---------------------------------------------------------------------------
// Injection scanning
// ---------------------------------------------------------------------------

export type WorkInjectionSignal =
  | 'assistant_directive'
  | 'system_prompt_probe'
  | 'tool_invocation_syntax'
  | 'credential_exfiltration'
  | 'encoded_payload'
  | 'envelope_escape';

export type WorkInjectionSeverity = 'none' | 'suspicious' | 'hostile';

/**
 * The event-safe shape of a scan result: what was seen, never what it said.
 *
 * The matched spans stay in the verdict the executor holds. Putting them on an
 * event would publish attacker-authored text to every client attached to the
 * run, which is the delivery mechanism the scan exists to interrupt.
 */
export interface WorkInjectionSummary {
  detected: boolean;
  severity: WorkInjectionSeverity;
  signals: WorkInjectionSignal[];
  matchCount: number;
}

// ---------------------------------------------------------------------------
// Validation and the report
// ---------------------------------------------------------------------------

export interface WorkValidationCheck {
  /** The property being asserted, phrased as a claim about the deliverable. */
  claim: string;
  satisfied: boolean;
  /** What was looked at. A failed check with no evidence is unactionable. */
  evidence: string;
}

export interface WorkValidationResult {
  satisfied: boolean;
  checks: WorkValidationCheck[];
  /** The claims that failed, restated for the user. */
  unmet: string[];
}

export interface WorkActionRecord {
  callId: string;
  tool: string;
  intent: string;
  provenance: WorkProvenance;
  isError: boolean;
  at: string;
}

export interface WorkDecision {
  summary: string;
  /** The reason, in one sentence. Not the reasoning that produced it. */
  because: string;
  alternatives?: string[];
}

/**
 * What a finished run tells the user.
 *
 * Note what is not here. There is no field for the model's deliberation, and
 * that is the design: a run reports the plan it followed, the actions it took,
 * the sources it used, the choices it made, what it remains unsure of, and the
 * evidence that the deliverable answers the goal. Intermediate reasoning is
 * neither verifiable nor stable, and a user who is shown it starts trusting
 * the narrative instead of the evidence. `runAgentLoop` already drops
 * `thinking_delta` at the provider seam; this type is the second half of that
 * decision, so no surface can render what no field carries.
 */
export interface WorkReport {
  goal: string;
  plan: WorkPlanSnapshot;
  actions: WorkActionRecord[];
  citations: WorkCitation[];
  decisions: WorkDecision[];
  /** What the run could not establish. An empty list is itself a claim. */
  uncertainties: string[];
  verification: WorkValidationResult;
  artifacts: WorkArtifactRef[];
  /** The final assistant text of the run. */
  answer: string;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Everything a Work run emits, discriminated on a name from WORK_EVENT_KINDS.
 *
 * A kind that is not in that list cannot be constructed here, which is the
 * point: the persistence layer maps `kind` straight onto WorkEvent.kind and
 * derives visibility from it, so a name invented in the runner would be stored
 * as an event no client can classify and every client would hide.
 */
export type WorkEvent =
  | { kind: 'run_started'; runId: string; goal: string; model: string }
  | { kind: 'plan_created'; plan: WorkPlanSnapshot }
  | { kind: 'plan_updated'; plan: WorkPlanSnapshot; diff: WorkPlanDiff }
  | { kind: 'step_started'; stepId: string; title: string }
  | {
      kind: 'step_finished';
      stepId: string;
      title: string;
      status: WorkPlanStepStatus;
      reason?: string;
    }
  | { kind: 'assistant_message'; text: string }
  | {
      kind: 'tool_started';
      callId: string;
      tool: string;
      intent: string;
      tier: WorkToolTierId;
      risk: WorkRiskLevel;
      summary: string;
      provenance: WorkProvenance;
    }
  | {
      kind: 'tool_finished';
      callId: string;
      tool: string;
      isError: boolean;
      durationMs: number;
      provenance: WorkProvenance;
      injection?: WorkInjectionSummary;
    }
  | { kind: 'tool_denied'; callId: string; tool: string; reason: string }
  | { kind: 'question_asked'; question: WorkQuestion }
  | { kind: 'question_answered'; questionId: string; answer: string }
  | { kind: 'approval_requested'; request: WorkApprovalRequest }
  | { kind: 'approval_resolved'; requestId: string; decision: WorkApprovalAnswer }
  | { kind: 'artifact_created'; artifact: WorkArtifactRef }
  | { kind: 'artifact_updated'; artifact: WorkArtifactRef }
  | { kind: 'source_cited'; citation: WorkCitation }
  | { kind: 'budget_warning'; limit: 'cost' | 'tokens' | 'runtime'; detail: string }
  | { kind: 'paused'; reason: string }
  | { kind: 'resumed' }
  | { kind: 'validation_result'; result: WorkValidationResult }
  | {
      kind: 'run_finished';
      terminalReason: WorkTerminalReason;
      detail: string;
      usage: BudgetUsage;
      report: WorkReport;
    }
  | { kind: 'error'; message: string };

/**
 * An event as it leaves the runtime: ordered and timestamped.
 *
 * `seq` is assigned by the session and is the cursor clients resume from, so
 * it is stamped here rather than by whoever persists the event — two writers
 * numbering the same stream is how a client silently skips an approval.
 */
export type WorkEmittedEvent = WorkEvent & { seq: number; at: string };

/**
 * An audit record the runtime wants written.
 *
 * Produced, never written, by this package: the runner has no database. The
 * detail is restricted to identifiers, counts and verdicts because the audit
 * writer in src/lib/work/audit.ts strips anything else, and a detail that is
 * silently dropped there is a refusal nobody can explain afterwards.
 */
export interface WorkAuditIntent {
  kind: WorkAuditKind;
  severity: WorkAuditSeverity;
  detail: Record<string, string | number | boolean>;
}

/** Token counts as the loop reports them, before pricing is applied. */
export type WorkStepUsage = Usage;

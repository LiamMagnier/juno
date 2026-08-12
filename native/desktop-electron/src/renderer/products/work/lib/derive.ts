/**
 * Reading the log.
 *
 * Everything the Work surface draws about a run is derived here, from the
 * append-only event list plus the run row, in one pass. Components receive
 * finished shapes and render them; none of them reduces events itself.
 *
 * Three decisions this module encodes:
 *
 * **The plan is rebuilt, never patched.** `derivePlan` takes the *newest*
 * `plan_created` / `plan_updated` and replays only the step events after it. A
 * re-plan can drop, rename or reorder steps, and merging a revision into the
 * previous list produces a plan that was nobody's plan — with rows the model
 * removed still sitting there marked done.
 *
 * **Nothing is left spinning.** A step still `active`, or a tool call still
 * open, when the run reached a terminal status is `unreported`: a state only the
 * reader can conclude and no executor may claim. This is the single most
 * important thing in the file. A spinner that outlives its run tells the user
 * work is happening when the process that would do it has exited.
 *
 * **"Running" requires a running run.** A step is only drawn as working when the
 * run is actually live *and* not stopped on a person. A step that is `active`
 * while the run sits in `waiting_approval` is blocked, and drawing it as busy
 * is how a user waits twenty minutes for a decision only they can make.
 */

import type {
  WorkActionRecord,
  WorkApproval,
  WorkArtifactRef,
  WorkCitation,
  WorkEmittedEvent,
  WorkPlanStep,
  WorkQuestion,
  WorkRun,
  WorkSession,
} from '../contract.js';
import { parseInstant } from './format.js';
import {
  isLiveStatus,
  isTerminalStatus,
  RISK_WEIGHT,
  type WorkDegradationKind,
  type WorkPlanStepStatus,
  type WorkRiskLevel,
  type WorkStatus,
  type WorkStepPresentation,
  type WorkToolTierId,
} from './vocabulary.js';

/* -------------------------------------------------------------------------- */
/* Plan                                                                        */
/* -------------------------------------------------------------------------- */

export interface DerivedStep {
  readonly id: string;
  readonly title: string;
  /** What the executor claimed. */
  readonly status: WorkPlanStepStatus;
  /** How it reads to a person. See `stepPresentation`. */
  readonly presentation: WorkStepPresentation;
  /** Required by the plan's API for `skipped` and `failed`. */
  readonly reason: string | null;
  /** 1-based, for "step 3 of 7". */
  readonly position: number;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export interface DerivedPlan {
  readonly version: number;
  readonly steps: readonly DerivedStep[];
  /** The step being worked on, if the run is in a state where one can be. */
  readonly activeStep: DerivedStep | null;
  readonly total: number;
  /** `done` plus `skipped` — both are conclusions, and the tally counts them. */
  readonly concluded: number;
  readonly failed: number;
  readonly remaining: number;
  /** True when no executor has written a plan yet. */
  readonly empty: boolean;
}

const EMPTY_PLAN: DerivedPlan = {
  version: 0,
  steps: [],
  activeStep: null,
  total: 0,
  concluded: 0,
  failed: 0,
  remaining: 0,
  empty: true,
};

/**
 * How a step reads, given what the executor claimed and what the run is doing.
 *
 * The `active` branch is the whole point: four different things are true of an
 * active step depending on the run around it, and only one of them is "working".
 */
export function stepPresentation(
  status: WorkPlanStepStatus,
  runStatus: WorkStatus | null,
): WorkStepPresentation {
  if (status !== 'active') return status;
  if (runStatus === null) return 'pending';
  switch (runStatus) {
    case 'waiting_input':
      return 'awaiting_input';
    case 'waiting_approval':
      return 'awaiting_approval';
    case 'paused':
      return 'blocked';
    case 'draft':
    case 'queued':
      return 'pending';
    case 'preparing':
    case 'running':
      return 'running';
    default:
      /* Every remaining status is terminal. A step still open when the run
         stopped was never concluded, and nothing may claim otherwise. */
      return 'unreported';
  }
}

export function derivePlan(
  events: readonly WorkEmittedEvent[],
  runStatus: WorkStatus | null,
): DerivedPlan {
  let base: readonly WorkPlanStep[] | null = null;
  let version = 0;
  let baseIndex = -1;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (event.kind === 'plan_created' || event.kind === 'plan_updated') {
      base = event.plan.steps;
      version = event.plan.version;
      baseIndex = index;
      break;
    }
  }

  if (base === null) return EMPTY_PLAN;

  const byId = new Map<string, { step: WorkPlanStep; startedAt: string | null; finishedAt: string | null }>();
  const order: string[] = [];
  for (const step of base) {
    byId.set(step.id, { step: { ...step }, startedAt: null, finishedAt: null });
    order.push(step.id);
  }

  for (let index = baseIndex + 1; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (event.kind === 'step_started') {
      const entry = byId.get(event.stepId);
      if (entry === undefined) continue;
      /* Only one step is ever active: starting a second returns the first to
         pending, exactly as `WorkPlan.start` does. Two active steps render as
         two busy rows and the reader cannot tell which one is real. */
      for (const other of byId.values()) {
        if (other.step.status === 'active') other.step = { ...other.step, status: 'pending' };
      }
      entry.step = { id: entry.step.id, title: entry.step.title, status: 'active' };
      entry.startedAt = event.at;
      entry.finishedAt = null;
    } else if (event.kind === 'step_finished') {
      const entry = byId.get(event.stepId);
      if (entry === undefined) continue;
      entry.step = {
        id: entry.step.id,
        title: entry.step.title,
        status: event.status,
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      };
      entry.finishedAt = event.at;
    }
  }

  const steps: DerivedStep[] = order.map((id, index) => {
    const entry = byId.get(id);
    const step: WorkPlanStep = entry?.step ?? { id, title: id, status: 'pending' };
    return {
      id: step.id,
      title: step.title,
      status: step.status,
      presentation: stepPresentation(step.status, runStatus),
      reason: step.reason ?? null,
      position: index + 1,
      startedAt: entry?.startedAt ?? null,
      finishedAt: entry?.finishedAt ?? null,
    };
  });

  const concluded = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const failed = steps.filter((s) => s.status === 'failed').length;
  const activeStep = steps.find((s) => s.status === 'active') ?? null;

  return {
    version,
    steps,
    activeStep,
    total: steps.length,
    concluded,
    failed,
    remaining: steps.length - concluded - failed,
    empty: steps.length === 0,
  };
}

export interface PlanRevision {
  readonly toVersion: number;
  readonly at: string;
  readonly added: number;
  readonly removed: number;
  readonly retitled: number;
  readonly statusChanged: number;
  readonly reordered: boolean;
}

/**
 * What moved the last time the model changed its mind.
 *
 * The plan itself is a fresh list, which is exactly why this is needed
 * separately: a re-rendered list cannot say "these seven rows are the same seven
 * rows", and "Juno revised the plan" with no account of what changed is the
 * moment a reader stops trusting the plan at all.
 */
export function latestPlanRevision(events: readonly WorkEmittedEvent[]): PlanRevision | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.kind !== 'plan_updated') continue;
    const { diff } = event;
    return {
      toVersion: diff.toVersion,
      at: event.at,
      added: diff.added.length,
      removed: diff.removed.length,
      retitled: diff.retitled.length,
      statusChanged: diff.statusChanged.length,
      reordered: diff.reordered,
    };
  }
  return null;
}

/** "2 steps added, 1 removed" — or null when the revision moved nothing structural. */
export function describeRevision(revision: PlanRevision): string | null {
  const parts: string[] = [];
  if (revision.added > 0) parts.push(`${revision.added} added`);
  if (revision.removed > 0) parts.push(`${revision.removed} removed`);
  if (revision.retitled > 0) parts.push(`${revision.retitled} reworded`);
  if (revision.reordered) parts.push('reordered');
  return parts.length === 0 ? null : parts.join(', ');
}

/* -------------------------------------------------------------------------- */
/* The current action                                                          */
/* -------------------------------------------------------------------------- */

export type CallState = 'running' | 'done' | 'failed' | 'refused' | 'unreported';

export interface DerivedCall {
  readonly callId: string;
  readonly tool: string;
  readonly intent: string;
  readonly tier: WorkToolTierId;
  readonly risk: WorkRiskLevel;
  readonly summary: string;
  readonly source: string;
  readonly trust: 'trusted' | 'untrusted';
  readonly state: CallState;
  readonly startedAt: string;
  readonly durationMs: number | null;
  /** Present only when the executor's scan found something. Never the matched text. */
  readonly injectionSeverity: 'none' | 'suspicious' | 'hostile' | null;
  readonly failureReason: string | null;
}

/**
 * Every tool call in the run, paired by `callId`, with anything still open at a
 * terminal event marked `unreported` rather than left running.
 */
export function deriveCalls(
  events: readonly WorkEmittedEvent[],
  runStatus: WorkStatus | null,
): readonly DerivedCall[] {
  const open = new Map<string, DerivedCall>();
  const closed: DerivedCall[] = [];
  const order: string[] = [];

  const strand = (): void => {
    for (const id of order) {
      const call = open.get(id);
      if (call === undefined) continue;
      closed.push({ ...call, state: 'unreported' });
      open.delete(id);
    }
    order.length = 0;
  };

  for (const event of events) {
    switch (event.kind) {
      case 'tool_started': {
        const call: DerivedCall = {
          callId: event.callId,
          tool: event.tool,
          intent: event.intent,
          tier: event.tier,
          risk: event.risk,
          summary: event.summary,
          source: event.provenance.source,
          trust: event.provenance.trust,
          state: 'running',
          startedAt: event.at,
          durationMs: null,
          injectionSeverity: null,
          failureReason: null,
        };
        open.set(event.callId, call);
        order.push(event.callId);
        break;
      }
      case 'tool_finished': {
        const call = open.get(event.callId);
        if (call === undefined) break;
        open.delete(event.callId);
        const index = order.indexOf(event.callId);
        if (index >= 0) order.splice(index, 1);
        closed.push({
          ...call,
          state: event.isError ? 'failed' : 'done',
          durationMs: event.durationMs,
          injectionSeverity: event.injection?.severity ?? null,
        });
        break;
      }
      case 'tool_denied': {
        const call = open.get(event.callId);
        if (call === undefined) break;
        open.delete(event.callId);
        const index = order.indexOf(event.callId);
        if (index >= 0) order.splice(index, 1);
        closed.push({ ...call, state: 'refused', failureReason: event.reason });
        break;
      }
      case 'run_finished':
      case 'error':
      case 'paused':
        strand();
        break;
      default:
        break;
    }
  }

  /* A run that is over cannot have a call in flight, whatever the log says: the
     process that would have written the closing event is gone. */
  if (runStatus !== null && isTerminalStatus(runStatus)) strand();

  const stillOpen = order
    .map((id) => open.get(id))
    .filter((call): call is DerivedCall => call !== undefined);

  return [...closed, ...stillOpen].sort(
    (a, b) => (parseInstant(a.startedAt) ?? 0) - (parseInstant(b.startedAt) ?? 0),
  );
}

/** The one call actually in flight, if any. Null whenever the run is not live. */
export function currentCall(
  calls: readonly DerivedCall[],
  runStatus: WorkStatus | null,
): DerivedCall | null {
  if (runStatus === null || !isLiveStatus(runStatus)) return null;
  if (runStatus !== 'running' && runStatus !== 'preparing') return null;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (call !== undefined && call.state === 'running') return call;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* What needs the user                                                         */
/* -------------------------------------------------------------------------- */

export interface AttentionQueue {
  readonly questions: readonly WorkQuestion[];
  readonly approvals: readonly WorkApproval[];
  readonly total: number;
  /** The one sentence the live region announces. Null when nothing is waiting. */
  readonly announcement: string | null;
}

/**
 * Questions and approvals that are genuinely answerable right now.
 *
 * Expired approvals are dropped outright rather than drawn with two buttons
 * guaranteed to fail — the read paths on the server drop them for the same
 * reason. Questions are matched by id because two can be open at once, and
 * answering one must not close the other.
 */
export function deriveAttention(
  questions: readonly WorkQuestion[],
  approvals: readonly WorkApproval[],
  now: number,
): AttentionQueue {
  const pending = approvals
    .filter((approval) => {
      if (approval.decision !== 'pending') return false;
      const expiry = parseInstant(approval.expiresAt);
      return expiry === null || expiry > now;
    })
    /* Highest consequence first, then soonest to expire. With three requests
       open, the irreversible one is the one that must not be answered last by
       somebody clicking down the list. */
    .sort((a, b) => {
      const byRisk = RISK_WEIGHT[b.risk] - RISK_WEIGHT[a.risk];
      if (byRisk !== 0) return byRisk;
      return (parseInstant(a.expiresAt) ?? Infinity) - (parseInstant(b.expiresAt) ?? Infinity);
    });

  const total = questions.length + pending.length;
  let announcement: string | null = null;
  if (total > 0) {
    const parts: string[] = [];
    if (questions.length > 0) {
      parts.push(questions.length === 1 ? 'a question' : `${questions.length} questions`);
    }
    if (pending.length > 0) {
      parts.push(pending.length === 1 ? 'an approval' : `${pending.length} approvals`);
    }
    announcement = `Juno needs your input: ${parts.join(' and ')}. Nothing else happens until you answer.`;
  }

  return { questions, approvals: pending, total, announcement };
}

/**
 * Whether an approval card can be answered from this window at all.
 *
 * The digest is what lets the server prove the card that was drawn is the row
 * being answered. Without a well-formed one there is no answer this client can
 * send that the server will accept, and offering buttons anyway is offering two
 * dead controls.
 */
export function approvalIsAnswerable(approval: WorkApproval): boolean {
  return /^[0-9a-f]{64}$/.test(approval.actionDigest);
}

export const APPROVAL_UNANSWERABLE_REASON =
  'This request did not arrive with the signature Juno needs to accept an answer from this window. ' +
  'Decide it on the Mac that raised it.';

/* -------------------------------------------------------------------------- */
/* Outputs, sources and the audit trail                                        */
/* -------------------------------------------------------------------------- */

export interface DerivedOutputs {
  /** Newest version of each artifact, in first-seen order. */
  readonly artifacts: readonly WorkArtifactRef[];
  readonly citations: readonly WorkCitation[];
  /** Display labels only. A row with no label degrades to a count, never a path. */
  readonly changedFiles: readonly string[];
  readonly changedFileCount: number;
  readonly answer: string | null;
}

export function deriveOutputs(events: readonly WorkEmittedEvent[]): DerivedOutputs {
  const artifacts = new Map<string, WorkArtifactRef>();
  const citations: WorkCitation[] = [];
  const changedFiles: string[] = [];
  let changedFileCount = 0;
  let answer: string | null = null;

  for (const event of events) {
    switch (event.kind) {
      case 'artifact_created':
      case 'artifact_updated': {
        const existing = artifacts.get(event.artifact.id);
        if (existing === undefined || event.artifact.version >= existing.version) {
          artifacts.set(event.artifact.id, event.artifact);
        }
        break;
      }
      case 'source_cited':
        citations.push(event.citation);
        break;
      case 'files_changed':
        changedFileCount += event.added + event.modified + event.removed;
        for (const path of event.paths) changedFiles.push(path);
        break;
      case 'run_finished':
        answer = event.report.answer.trim().length > 0 ? event.report.answer : null;
        break;
      case 'assistant_message':
        if (answer === null && event.text.trim().length > 0) answer = event.text;
        break;
      default:
        break;
    }
  }

  return {
    artifacts: [...artifacts.values()],
    citations,
    changedFiles,
    changedFileCount: Math.max(changedFileCount, changedFiles.length),
    answer,
  };
}

/**
 * One row of the audit trail: what was done, when, by what, under what
 * permission.
 *
 * Built from the run's own actions rather than only from `WorkAuditEvent`,
 * because the two answer different questions. The audit table records the
 * security-relevant facts (a grant, a refusal, a detected injection); the action
 * list records everything the run touched. A trail that showed only the first
 * would let a run read forty files and report nothing, and a trail that showed
 * only the second would omit every refusal.
 */
export interface AuditRow {
  readonly key: string;
  readonly at: string;
  readonly what: string;
  readonly tool: string;
  readonly source: string;
  readonly sourceKind: WorkActionRecord['provenance']['sourceKind'];
  readonly action: string;
  readonly trust: 'trusted' | 'untrusted';
  readonly isError: boolean;
  /**
   * How this call was permitted: an approval the user personally answered, or
   * the standing permission mode. Never guessed — `null` means the log does not
   * say, and the UI prints that rather than inventing an authority.
   */
  readonly authority: 'approved_once' | 'approved_standing' | 'denied' | 'policy' | null;
}

export function deriveAuditRows(
  events: readonly WorkEmittedEvent[],
  actions: readonly WorkActionRecord[],
): readonly AuditRow[] {
  /* action identifier -> the decision the user actually gave. Joined through
     the approval id, which is the only link between "Juno asked" and "you
     answered" that survives a reload. */
  const requestedAction = new Map<string, string>();
  const decisionByAction = new Map<string, AuditRow['authority']>();

  for (const event of events) {
    if (event.kind === 'approval_requested') {
      requestedAction.set(event.request.id, event.request.action);
    } else if (event.kind === 'approval_resolved') {
      const action = requestedAction.get(event.requestId);
      if (action === undefined) continue;
      if (event.decision === 'allowed') decisionByAction.set(action, 'approved_once');
      else if (event.decision === 'allowed_always') decisionByAction.set(action, 'approved_standing');
      else if (event.decision === 'denied') decisionByAction.set(action, 'denied');
    }
  }

  return actions.map((record) => ({
    key: record.callId,
    at: record.at,
    what: record.intent,
    tool: record.tool,
    source: record.provenance.source,
    sourceKind: record.provenance.sourceKind,
    action: record.provenance.action,
    trust: record.provenance.trust,
    isError: record.isError,
    authority: decisionByAction.get(record.provenance.action) ?? null,
  }));
}

export interface DerivedDegradation {
  readonly kind: WorkDegradationKind;
  readonly detail: string;
  readonly at: string;
}

export function deriveDegradations(
  events: readonly WorkEmittedEvent[],
): readonly DerivedDegradation[] {
  const out: DerivedDegradation[] = [];
  for (const event of events) {
    if (event.kind === 'degraded') {
      out.push({ kind: event.degradation, detail: event.detail, at: event.at });
    }
  }
  return out;
}

/** The newest event's timestamp — what "quiet since" is measured from. */
export function lastActivityAt(events: readonly WorkEmittedEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined) return event.at;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Controls                                                                    */
/* -------------------------------------------------------------------------- */

export const WORK_CONTROLS = ['pause', 'resume', 'cancel', 'retry', 'steer'] as const;
export type WorkControl = (typeof WORK_CONTROLS)[number];

export interface ControlState {
  readonly enabled: boolean;
  /** Why not. Required whenever `enabled` is false — rendered, not just a title. */
  readonly reason: string | null;
}

export type ControlStates = Readonly<Record<WorkControl, ControlState>>;

/**
 * Which controls are live, and why the rest are not.
 *
 * Every disabled control carries a sentence. A greyed-out button with no reason
 * is the same as a missing feature except that the user can see it and cannot
 * find out why — and this surface has five of them, which is five chances to
 * make somebody feel locked out of their own task.
 *
 * `steer` is the interesting one. A run that is `waiting_input` refuses an
 * instruction: it is stopped, and accepting one would tell the user their words
 * were delivered to something that had not moved. Answer the question instead.
 */
export function deriveControls(
  session: WorkSession,
  run: WorkRun | null,
  options: { readonly offline: boolean },
): ControlStates {
  const status: WorkStatus = run?.status ?? session.status;
  const live = isLiveStatus(status);
  const terminal = isTerminalStatus(status);

  const gate = (enabled: boolean, reason: string): ControlState => {
    if (options.offline) {
      return { enabled: false, reason: 'Juno cannot be reached from this Mac right now.' };
    }
    return enabled ? { enabled: true, reason: null } : { enabled: false, reason };
  };

  const pausable = status === 'running' || status === 'preparing';
  const cancellable = live && status !== 'draft';

  return {
    pause: gate(
      pausable,
      status === 'paused'
        ? 'Already paused.'
        : live
          ? 'Nothing is executing to pause — this run is waiting on you.'
          : 'This run is over.',
    ),
    resume: gate(
      status === 'paused',
      terminal ? 'This run is over. Start another attempt instead.' : 'This run is not paused.',
    ),
    cancel: gate(
      cancellable,
      status === 'draft' ? 'This has never been started.' : 'This run is already over.',
    ),
    retry: gate(
      terminal || status === 'draft',
      'This attempt is still going. Cancel it first, or wait for it to finish.',
    ),
    steer: gate(
      live && status !== 'draft' && status !== 'waiting_input',
      status === 'waiting_input'
        ? 'This run is stopped on a question. Answer it rather than sending an instruction.'
        : status === 'draft'
          ? 'This has never been started.'
          : 'This run is over. Anything you send now would go nowhere.',
    ),
  };
}

/**
 * The caveat under every control that changes the task rather than the attempt.
 *
 * Stated once, plainly, because a control that implies otherwise is a progress
 * bar that completes while the run never sees the file.
 */
export const NEXT_ATTEMPT_CAVEAT =
  'A change made during an attempt takes effect on the next attempt — except a message, ' +
  'which the attempt in flight reads before its next step. What it has already done stands.';

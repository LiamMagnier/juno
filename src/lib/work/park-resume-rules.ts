import { answerTextFromPayload } from "@/lib/work/answer-lookup";
import { actionDigest, canonicalize, verifyApproval } from "@/lib/work/digests";
import type { WorkApprovalDecision } from "@/lib/work/domain";

/*
 * The rules of "needs you" after a run has been set aside, free of the
 * database and of `server-only` so they are unit-tested as they are. The reads
 * that feed them are `src/lib/work/park-resume.ts`, which says how the pieces
 * fit together.
 */

// ---------------------------------------------------------------------------
// Owner-tunable numbers (docs/OPEN_DECISIONS.md §8, "owner to confirm")
// ---------------------------------------------------------------------------

/**
 * How long a cloud executor stays attached to a run that is waiting for a
 * person before it parks the run and frees its slot.
 *
 * It was four minutes, which was the right trade while a parked run could only
 * be continued by pressing Resume and answering again. Now that an answer to a
 * parked run requeues it, waiting long buys little and costs one of the
 * executor's few slots for every account while it lasts. A minute still lets a
 * person who is watching answer in place, without the cold start a requeue
 * costs.
 */
export const DEFAULT_ATTENDED_WAIT_MS = 60_000;
const MIN_ATTENDED_WAIT_MS = 1_000;
const MAX_ATTENDED_WAIT_MS = 4 * 60_000;

/** `WORK_ATTENDED_WAIT_MS`, bounded; the default when unset or unreadable. */
export function attendedWaitMs(raw: string | undefined = process.env.WORK_ATTENDED_WAIT_MS): number {
  return boundedInteger(raw, DEFAULT_ATTENDED_WAIT_MS, MIN_ATTENDED_WAIT_MS, MAX_ATTENDED_WAIT_MS);
}

/**
 * How many parked runs (status `paused`) one account may hold before starting
 * another task is refused.
 *
 * A parked run holds no executor, so it no longer counts against the live cap
 * (`WORK_RUN_CONCURRENCY_CAP` in dispatch.ts). It is still a task waiting on
 * the person with a checkpoint and a spend hold behind it, and without a bound
 * of their own they could pile up for ever.
 */
export const DEFAULT_MAX_PARKED_RUNS_PER_ACCOUNT = 10;

/** `WORK_MAX_PARKED_RUNS_PER_ACCOUNT`, bounded; the default when unset or unreadable. */
export function maxParkedRunsPerAccount(
  raw: string | undefined = process.env.WORK_MAX_PARKED_RUNS_PER_ACCOUNT
): number {
  return boundedInteger(raw, DEFAULT_MAX_PARKED_RUNS_PER_ACCOUNT, 1, 100);
}

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw.trim());
  if (!Number.isFinite(value) || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Which question is open
// ---------------------------------------------------------------------------

/** One event, as much as `deriveQuestionState` reads. */
export interface QuestionEventRow {
  seq: number;
  kind: string;
  /** The stored JSON, read defensively. */
  payload: unknown;
}

export interface QuestionState {
  /** The run asked this question at some point. */
  asked: boolean;
  /** Asked in the run's latest execution and not yet answered. */
  open: boolean;
  /** The recorded answer, when there is one. */
  answer: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The id a `question_asked` payload carries, in either executor's shape. */
export function askedQuestionId(payload: unknown): string | null {
  const flat = record(payload);
  const nested = record(flat.question);
  for (const candidate of [nested.id, flat.questionId, flat.id]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
}

/**
 * Whether a `run_started` row marks a cloud execution starting.
 *
 * The cloud executor writes `{ executor: "cloud" }` each time it claims a run,
 * including after a park, and that is the boundary that matters: a question
 * asked before it belonged to an execution that has ended, and the restored run
 * either received its answer or asks again under a new id. A Mac does not write
 * this marker, so its questions are never closed by it.
 */
export function isCloudExecutionStart(kind: string, payload: unknown): boolean {
  return kind === "run_started" && record(payload).executor === "cloud";
}

/** The state of one question, from a run's question and start events in seq order. */
export function deriveQuestionState(events: readonly QuestionEventRow[], questionId: string): QuestionState {
  let latestStart = 0;
  let lastAsk: number | null = null;
  let answer: string | null = null;
  for (const event of events) {
    if (isCloudExecutionStart(event.kind, event.payload)) latestStart = Math.max(latestStart, event.seq);
    if (event.kind === "question_asked" && askedQuestionId(event.payload) === questionId) {
      lastAsk = Math.max(lastAsk ?? 0, event.seq);
    }
    if (event.kind === "question_answered" && answer === null) {
      answer = answerTextFromPayload(event.payload, questionId);
    }
  }
  const asked = lastAsk !== null;
  return { asked, open: asked && answer === null && (lastAsk ?? 0) > latestStart, answer };
}

// ---------------------------------------------------------------------------
// Giving a resumed run what the person said
// ---------------------------------------------------------------------------

/** A tool call a parked run stopped on (the runtime's `WorkParkedCall`). */
export interface ParkedCallRef {
  id: string;
  name: string;
  input: unknown;
}

/** What replaces a parked call's stopped result (the runtime's `WorkParkedResolution`). */
export interface ParkedResolution {
  content: string;
  isError: boolean;
  answer?: boolean;
}

/**
 * The result a parked call gets when the person approved it while the run was
 * set aside. It does not perform the action: the model calls the tool again,
 * and that call passes the approval gate on the recorded decision only if it
 * is the same action (digest), under the same policy, before the decision's
 * own expiry. Anything else asks again.
 */
export const APPROVED_WHILE_PARKED =
  "The person approved this while the task was waiting for them. Call the same tool again with exactly the same input to carry it out.";

/** The runtime's own sentence for a denial, so a denial reads the same either way. */
export const DECLINED_WHILE_PARKED = "The user declined this action.";

/** One stored approval, as much as reusing its decision needs. */
export interface RecordedApproval {
  id: string;
  action: string;
  actionDigest: string;
  policyDigest: string;
  decision: string;
  expiresAt: Date;
  detail: unknown;
}

export type RecordedApprovalVerdict =
  | { use: true; decision: "allowed" | "allowed_always" | "denied" }
  | { use: false; reason: "undecided" | "expired" | "digest_mismatch" | "policy_changed" };

/**
 * Whether a stored decision answers a request for an action, now.
 *
 * The digest is recomputed from the action about to run and compared with the
 * one stored when the person was asked; the policy digest likewise; and the
 * stored expiry is the expiry. A denial needs only the digest: applying a "no"
 * can never do something nobody agreed to.
 */
export function judgeRecordedApproval(input: {
  row: RecordedApproval;
  action: string;
  detail: unknown;
  policy: unknown;
  now: Date;
}): RecordedApprovalVerdict {
  const { row } = input;
  if (row.decision !== "allowed" && row.decision !== "allowed_always" && row.decision !== "denied") {
    return { use: false, reason: row.decision === "expired" ? "expired" : "undecided" };
  }
  if (actionDigest(input.action, input.detail) !== row.actionDigest) return { use: false, reason: "digest_mismatch" };
  if (row.decision === "denied") return { use: true, decision: "denied" };
  const verdict = verifyApproval({
    storedDigest: row.actionDigest,
    storedPolicyDigest: row.policyDigest,
    action: input.action,
    detail: input.detail,
    policy: input.policy,
    decision: row.decision as WorkApprovalDecision,
    expiresAt: row.expiresAt,
    now: input.now,
  });
  if (verdict.ok) return { use: true, decision: row.decision };
  return { use: false, reason: verdict.reason === "not_allowed" ? "undecided" : verdict.reason };
}

/** The identity of a call for matching: its tool and its canonical input. */
export function parkedCallKey(tool: string, input: unknown): string {
  return canonicalize({ tool, input: input ?? null });
}

/** The call an approval row was asked for, from the detail it stores (`{ action, tool, input }`). */
export function approvalCallKey(row: Pick<RecordedApproval, "detail">): string | null {
  const detail = record(row.detail);
  return typeof detail.tool === "string" ? parkedCallKey(detail.tool, detail.input) : null;
}

/** A question's words, for matching a re-ask: case and spacing do not count. */
export function normalisedQuestion(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const normalised = text.replace(/\s+/g, " ").trim().toLowerCase();
  return normalised.length > 0 ? normalised : null;
}

/** The question an `ask_user` call asked, from its input. */
export function questionOfCall(input: unknown): string | null {
  return normalisedQuestion(record(input).question);
}

/** The outcome of offering a re-asked approval to the recorded decisions. */
export type ParkedApprovalOutcome =
  | { approvalId: string; use: true; decision: "allowed" | "allowed_always" | "denied" }
  | { approvalId: string; use: false; reason: Extract<RecordedApprovalVerdict, { use: false }>["reason"] };

/**
 * What the person said while the run was parked, for one execution, each
 * usable once.
 *
 * Only what answers the call the run parked on is held here, so a decision
 * can never be carried further than the action it was given for: a later,
 * identical action in the same run asks again.
 */
export class ParkedDecisions {
  /** By the parked call's id: the question as asked, normalised, and its answer. */
  private readonly answers: Map<string, { question: string; answer: string }>;
  private readonly approvals: Map<string, RecordedApproval>;

  constructor(
    answers: Map<string, { question: string; answer: string }> = new Map(),
    approvals: Map<string, RecordedApproval> = new Map()
  ) {
    this.answers = answers;
    this.approvals = approvals;
  }

  get size(): number {
    return this.answers.size + this.approvals.size;
  }

  /**
   * Forgets the answers the restored transcript already carries.
   *
   * A parked question the runtime settled (`settleParkedCalls`) has its answer
   * in front of the model; if the model then asks the same words again it is
   * asking something new, and the person is asked. Only an answer that could
   * not be put back into the transcript is kept for a re-ask.
   */
  delivered(callIds: Iterable<string>): void {
    for (const id of callIds) this.answers.delete(id);
  }

  /** The recorded answer to the same question, once; null to ask. */
  takeAnswer(question: string): string | null {
    const key = normalisedQuestion(question);
    if (key === null) return null;
    for (const [id, entry] of this.answers) {
      if (entry.question !== key) continue;
      this.answers.delete(id);
      return entry.answer;
    }
    return null;
  }

  /**
   * The recorded decision on the same call, once; null when there is none.
   * `use: false` says why it cannot be used, and the caller asks again.
   */
  takeApproval(
    request: { action: string; tool: string; digestInput: string },
    policy: unknown,
    now: Date
  ): ParkedApprovalOutcome | null {
    let detail: unknown;
    try {
      detail = JSON.parse(request.digestInput);
    } catch {
      return null;
    }
    const parsed = record(detail);
    const key = parkedCallKey(typeof parsed.tool === "string" ? parsed.tool : request.tool, parsed.input);
    const row = this.approvals.get(key);
    if (!row) return null;
    this.approvals.delete(key);
    const verdict = judgeRecordedApproval({ row, action: request.action, detail, policy, now });
    return verdict.use
      ? { approvalId: row.id, use: true, decision: verdict.decision }
      : { approvalId: row.id, use: false, reason: verdict.reason };
  }
}

/**
 * Pure half of `loadParkedDecisions`: the resolutions and the per-execution
 * ledger, from the parked calls, the answers found for the questions among
 * them, and the run's approval rows (newest first).
 */
export function planParkedDecisions(input: {
  calls: readonly ParkedCallRef[];
  askToolName: string;
  /** Recorded answers, by the parked question call's id. */
  answers: ReadonlyMap<string, string>;
  /** The run's approval rows, newest first. */
  approvals: readonly RecordedApproval[];
  policy: unknown;
  now: Date;
}): { resolutions: Map<string, ParkedResolution>; decisions: ParkedDecisions } {
  const resolutions = new Map<string, ParkedResolution>();
  const answers = new Map<string, { question: string; answer: string }>();
  const approvals = new Map<string, RecordedApproval>();
  for (const call of input.calls) {
    if (call.name === input.askToolName) {
      const text = input.answers.get(call.id);
      if (text === undefined) continue;
      resolutions.set(call.id, { content: text, isError: false, answer: true });
      const asked = questionOfCall(call.input);
      if (asked !== null) answers.set(call.id, { question: asked, answer: text });
      continue;
    }
    const key = parkedCallKey(call.name, call.input);
    // Newest first: the approval the run parked on is the newest one asked for
    // this exact call. An older row for the same call was answered and used,
    // or abandoned, before it.
    const row = input.approvals.find((candidate) => approvalCallKey(candidate) === key);
    if (!row) continue;
    const verdict = judgeRecordedApproval({ row, action: row.action, detail: row.detail, policy: input.policy, now: input.now });
    if (!verdict.use) continue;
    approvals.set(key, row);
    resolutions.set(
      call.id,
      verdict.decision === "denied"
        ? { content: DECLINED_WHILE_PARKED, isError: true }
        : { content: APPROVED_WHILE_PARKED, isError: false }
    );
  }
  return { resolutions, decisions: new ParkedDecisions(answers, approvals) };
}

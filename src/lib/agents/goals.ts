/**
 * Durable goals: what an Orbit agent keeps working towards across sessions,
 * and the rules that keep it bounded.
 *
 * A goal is an objective (title + detail), ordered milestones, success
 * criteria, blockers, progress and a next action, with a budget and a run
 * bound. The driver (src/lib/agents/goal-runner.ts) advances a goal one step
 * at a time; every step is an ordinary Work task (`WorkSession.goalId`), so
 * leases, heartbeats, checkpoints, approvals and the stale-run sweep all come
 * from the existing ledger. Nothing here is a second queue.
 *
 * The rules (adapted from Hermes Agent's /goal, which bounds a standing goal by
 * a turn budget and pauses rather than fails when it runs out):
 *
 *   - One task per goal at a time. A goal never fans out on its own.
 *   - At most `maxRuns` tasks in total, then the goal pauses and asks to
 *     continue. Its budget, when it has one, bounds it the same way.
 *   - A step that was interrupted before it did anything is retried, within
 *     `maxAttemptsPerStep`. One interrupted after it started acting is not:
 *     it may already have changed something, so the goal waits for the person.
 *   - A failed step waits for the person. The goal never loops on failure.
 *   - All milestones done is not "met". The final step's run checks the
 *     success criteria against what the steps produced (the Work judge, with
 *     the agent's model: src/lib/agents/goal-criteria.ts). Only a check that
 *     passed makes the goal `achieved`; anything else leaves it `unverified`,
 *     "Every step ran. Check the result.", for the person to mark met or keep
 *     going (`planGoalCompletion`).
 *
 * Pure and client-safe.
 */

export const MAX_GOAL_MILESTONES = 12;
export const MAX_GOAL_CRITERIA = 8;
export const MAX_GOAL_RUNS_LIMIT = 50;
export const DEFAULT_GOAL_MAX_RUNS = 6;
/** How long the driver's lease on one goal lasts. Longer than one advance takes. */
export const GOAL_ADVANCE_LEASE_MS = 2 * 60_000;
/** The step key of a goal without milestones: it runs its next action. */
export const GOAL_NEXT_STEP_KEY = "next";

export interface GoalMilestone {
  id: string;
  title: string;
  done: boolean;
  sessionId?: string | null;
  doneAt?: string | null;
}

export type GoalBlockerKind = "run_budget" | "spend_budget" | "needs_decision" | "step_failed" | "agent_paused" | "overdue";

export interface GoalBlocker {
  kind: GoalBlockerKind;
  text: string;
  at: string;
}

function oneLine(value: unknown, max: number): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Milestones from a stored JSON column or a request: clipped, de-duplicated ids, at most 12. */
export function parseMilestones(value: unknown): GoalMilestone[] {
  if (!Array.isArray(value)) return [];
  const out: GoalMilestone[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of value.entries()) {
    if (out.length >= MAX_GOAL_MILESTONES) break;
    const item = typeof raw === "string" ? { title: raw } : (raw as Record<string, unknown> | null);
    if (!item || typeof item !== "object") continue;
    const title = oneLine(item.title, 160);
    if (!title) continue;
    let id = oneLine(item.id, 40).replace(/[^a-zA-Z0-9_-]/g, "") || `m${index + 1}`;
    while (ids.has(id) || id === GOAL_NEXT_STEP_KEY) id = `${id}_`;
    ids.add(id);
    out.push({
      id,
      title,
      done: item.done === true,
      sessionId: typeof item.sessionId === "string" ? item.sessionId : null,
      doneAt: typeof item.doneAt === "string" ? item.doneAt : null,
    });
  }
  return out;
}

export function parseCriteria(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => oneLine(item, 240)).filter(Boolean).slice(0, MAX_GOAL_CRITERIA);
}

export function parseBlockers(value: unknown): GoalBlocker[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => ({ kind: String(item.kind) as GoalBlockerKind, text: oneLine(item.text, 300), at: String(item.at ?? "") }))
    .filter((item) => item.text)
    .slice(0, 6);
}

/** `blocker` first, replacing any of its kind, at most four. */
export function withBlocker(existing: unknown, blocker: GoalBlocker): GoalBlocker[] {
  return [blocker, ...parseBlockers(existing).filter((b) => b.kind !== blocker.kind)].slice(0, 4);
}

/** A step start or retry that did not go ahead, as the driver's deps report it. */
export interface GoalStepNotStarted {
  message: string;
  /** The estimate needs the person's OK first. */
  needsConfirmation?: boolean;
  /**
   * Nothing was found wrong: the cloud heartbeat could not be read, so whether
   * a worker is alive is unknown (`isRetryLaterRefusal`). The next advance
   * tries the same step again.
   */
  retryLater?: boolean;
}

/** The goal's line while a step waits on a heartbeat that could not be read. */
export const GOAL_WAITING_ON_EXECUTOR_CHECK = "Waiting to check that a cloud worker is running";

/** The goal's line while its step waits for the person, attached or parked. */
export const GOAL_WAITING_FOR_ANSWER = "Waiting for your answer on the current task";

/**
 * What a step that did not start writes on the goal. Pure: the driver applies it.
 *
 * A refusal is a decision for the person: a `needs_decision` blocker, and a
 * `task_refused` line on the member the first time that refusal is seen. A
 * confirmation is a question, so it is not a refusal. "Retry later" is
 * neither: the unattended sweep could not read the cloud heartbeat, which
 * says nothing about whether the step can run, so it leaves the blockers as
 * they are, records nothing on the member, and only says what it is waiting
 * for. Reading it as "no executor" is how a database hiccup used to put a
 * false "No cloud worker is running" blocker on a goal for the person to clear.
 */
export function planStepNotStarted(input: {
  step: "start" | "retry";
  result: GoalStepNotStarted;
  blockers: unknown;
  now: Date;
}): { blockers: GoalBlocker[] | null; nextAction: string; recordRefusal: boolean } {
  const { result } = input;
  if (result.retryLater) return { blockers: null, nextAction: GOAL_WAITING_ON_EXECUTOR_CHECK, recordRefusal: false };
  const known = parseBlockers(input.blockers).some((b) => b.kind === "needs_decision" && b.text === result.message);
  const blockers = withBlocker(input.blockers, { kind: "needs_decision", text: result.message, at: input.now.toISOString() });
  if (input.step === "retry") {
    return { blockers, nextAction: "Waiting for you: the retry could not start", recordRefusal: !known };
  }
  return {
    blockers,
    nextAction: result.needsConfirmation ? "Waiting for your OK to spend on the next step" : "Waiting for you: the next step could not start",
    recordRefusal: !known && !result.needsConfirmation,
  };
}

/** 0..100 from milestones; a goal without milestones reports 0 until achieved. */
export function goalProgress(milestones: readonly GoalMilestone[], status: string): number {
  if (status === "achieved") return 100;
  if (milestones.length === 0) return 0;
  return Math.round((milestones.filter((m) => m.done).length / milestones.length) * 100);
}

/** The first milestone not done, or null. */
export function nextMilestone(milestones: readonly GoalMilestone[]): GoalMilestone | null {
  return milestones.find((m) => !m.done) ?? null;
}

/** What the driver needs to know about one of the goal's tasks. */
export interface GoalTaskView {
  sessionId: string;
  stepKey: string | null;
  /** WorkSession.status */
  status: string;
  /** The current run's attempt number, 1-based. */
  attempt: number;
  /**
   * Whether the current run started acting: called a tool, changed a file,
   * wrote an artifact or applied a batch (`GOAL_ACTING_EVENT_KINDS`). A run that
   * only started and planned did nothing a retry could repeat.
   */
  acted: boolean;
  costMicroUsd: number;
  createdAt: Date;
  /**
   * The current run is parked (`paused`) and why: `waiting` when the executor
   * set it aside to wait for an answer or approval, `user` when the person
   * paused it. Null or absent for anything else.
   */
  pauseReason?: string | null;
  /**
   * The current run was ended because it waited out the parked-run expiry
   * (`PARKED_GOAL_STEP_EXPIRED_DETAIL` in src/lib/work/store.ts) rather than
   * being interrupted mid-work. Retrying it on its own would only stop on the
   * same question again, so the goal asks the person instead.
   */
  waitedOut?: boolean;
}

export interface GoalView {
  id: string;
  title: string;
  detail: string;
  status: string;
  milestones: readonly GoalMilestone[];
  successCriteria: readonly string[];
  budgetMicroUsd: number | null;
  spentMicroUsd: number;
  maxRuns: number;
  runsUsed: number;
  maxAttemptsPerStep: number;
  dueAt: Date | null;
  /** none | daily | weekly: how often a goal without milestones takes its next step. */
  cadence: string;
}

export const GOAL_CADENCE_MS: Record<string, number | null> = {
  none: null,
  daily: 24 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000,
};

export type GoalStep =
  /** Nothing to do now (paused, achieved, dropped, or a task is in flight). */
  | { kind: "idle"; reason: "not_active" | "task_in_flight"; nextAction: string | null }
  /** Start the next step as a new task. */
  | { kind: "start"; stepKey: string; stepTitle: string; title: string; prompt: string; idempotencyKey: string; nextAction: string }
  /** Retry the step's task: its run was interrupted before it did anything. */
  | { kind: "retry"; sessionId: string; stepKey: string; attempt: number; nextAction: string }
  /** A step's task completed: mark it, then the next advance starts the next step. */
  | { kind: "complete_step"; sessionId: string; stepKey: string; nextAction: string }
  /** Every milestone ran. Met or unverified is the criteria check's to say (`planGoalCompletion`). */
  | { kind: "achieved"; nextAction: string }
  /** Stop and ask the person. The goal pauses for a bound, or waits for a decision. */
  | { kind: "ask"; blocker: GoalBlocker; pause: boolean; nextAction: string };

/** Work event kinds that mean a run touched something outside its own transcript. */
export const GOAL_ACTING_EVENT_KINDS = ["tool_started", "tool_finished", "files_changed", "artifact_created", "artifact_updated", "batch_applied", "approval_resolved"] as const;

const LIVE = new Set(["draft", "queued", "preparing", "running", "waiting_input", "waiting_approval", "paused"]);
const RETRYABLE_INTERRUPT = new Set(["interrupted", "host_offline"]);

/** The newest task of each step, by step key. */
function latestByStep(tasks: readonly GoalTaskView[]): Map<string, GoalTaskView> {
  const map = new Map<string, GoalTaskView>();
  for (const task of [...tasks].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    map.set(task.stepKey ?? GOAL_NEXT_STEP_KEY, task);
  }
  return map;
}

export function composeGoalStepPrompt(goal: Pick<GoalView, "title" | "detail" | "successCriteria" | "milestones">, step: { title: string } | null): string {
  const done = goal.milestones.filter((m) => m.done).map((m) => `- ${m.title}`);
  const lines = [
    `You are working on a standing goal: ${goal.title}.`,
    goal.detail ? `Objective: ${goal.detail}` : "",
    step ? `This task is one milestone of it: ${step.title}. Do only this milestone, completely, and say plainly what you produced.` : "Take the next concrete step towards it, and say plainly what you did and what should happen next.",
    done.length ? `Already done:\n${done.join("\n")}` : "",
    goal.successCriteria.length ? `The goal is met when:\n${goal.successCriteria.map((c) => `- ${c}`).join("\n")}` : "",
    "If you need a decision or access you do not have, ask for it instead of guessing.",
  ];
  return lines.filter(Boolean).join("\n\n");
}

/**
 * The one step a goal should take now. Pure: the driver applies it.
 */
export function planGoalStep(
  goal: GoalView,
  tasks: readonly GoalTaskView[],
  now = new Date(),
  options: {
    /** The person pressed Continue on a failed or interrupted step: retry it once. */
    retryApproved?: boolean;
  } = {}
): GoalStep {
  const nowIso = now.toISOString();
  if (goal.status !== "active") return { kind: "idle", reason: "not_active", nextAction: null };

  const live = tasks.find((task) => LIVE.has(task.status));
  if (live) {
    // A step parked by the executor (`paused`, waiting) is waiting on the
    // person exactly as one still attached is; it is not working.
    const waiting =
      live.status === "waiting_input" ||
      live.status === "waiting_approval" ||
      (live.status === "paused" && live.pauseReason === "waiting");
    const pausedByPerson = live.status === "paused" && !waiting;
    return {
      kind: "idle",
      reason: "task_in_flight",
      nextAction: waiting
        ? GOAL_WAITING_FOR_ANSWER
        : pausedByPerson
          ? "Paused on the current step; resume it to continue"
          : "Working on the current step",
    };
  }

  const milestones = goal.milestones;
  const latest = latestByStep(tasks);
  const step = nextMilestone(milestones);
  if (milestones.length > 0 && !step) return { kind: "achieved", nextAction: "Every milestone is done" };
  const stepKey = step?.id ?? GOAL_NEXT_STEP_KEY;
  const last = latest.get(stepKey);

  // The step's own task finished: account for it before starting anything.
  if (last && last.status === "completed" && step) {
    return { kind: "complete_step", sessionId: last.sessionId, stepKey, nextAction: `Marking "${step.title}" done` };
  }
  const stopped = !!last && (last.status === "failed" || last.status === "timed_out" || last.status === "budget_exceeded" || RETRYABLE_INTERRUPT.has(last.status));
  if (last && stopped && options.retryApproved && goal.runsUsed < goal.maxRuns) {
    return { kind: "retry", sessionId: last.sessionId, stepKey, attempt: last.attempt + 1, nextAction: `Retrying "${step?.title ?? goal.title}" as you asked` };
  }
  if (last && (last.status === "failed" || last.status === "timed_out" || last.status === "budget_exceeded")) {
    return {
      kind: "ask",
      pause: false,
      blocker: { kind: "step_failed", text: `The task for "${step?.title ?? goal.title}" didn't finish. Retry it, change the goal, or drop it.`, at: nowIso },
      nextAction: "Waiting for your decision on the failed step",
    };
  }
  if (last && last.waitedOut && RETRYABLE_INTERRUPT.has(last.status)) {
    // Stopped after waiting a day for an answer that never came. Not retried
    // on its own: a fresh attempt would stop on the same question again and
    // spend a run of the goal's bound doing it. Continue retries it.
    return {
      kind: "ask",
      pause: false,
      blocker: {
        kind: "needs_decision",
        text: `"${step?.title ?? goal.title}" waited 24 hours for your answer and was stopped. Retry it, change the goal, or drop it.`,
        at: nowIso,
      },
      nextAction: "Waiting for you: the step stopped waiting for an answer",
    };
  }
  if (last && RETRYABLE_INTERRUPT.has(last.status)) {
    if (!last.acted && last.attempt < goal.maxAttemptsPerStep) {
      return { kind: "retry", sessionId: last.sessionId, stepKey, attempt: last.attempt + 1, nextAction: `Retrying "${step?.title ?? goal.title}" after an interruption` };
    }
    return {
      kind: "ask",
      pause: false,
      blocker: {
        kind: "needs_decision",
        text:
          !last.acted
            ? `"${step?.title ?? goal.title}" was interrupted ${last.attempt} times before it could start.`
            : `"${step?.title ?? goal.title}" was interrupted after it had started working, so it may already have changed something. Check it, then retry.`,
        at: nowIso,
      },
      nextAction: "Waiting for you to check the interrupted step",
    };
  }

  // A goal without milestones runs its next action once per check-in; a
  // completed "next" task is the step done, and the goal waits for the next
  // check-in or the person rather than chaining tasks back to back.
  if (!step && last && last.status === "completed") {
    const every = GOAL_CADENCE_MS[goal.cadence] ?? null;
    if (every === null || now.getTime() - last.createdAt.getTime() < every) {
      return { kind: "idle", reason: "not_active", nextAction: every === null ? "Step done; ask it to continue when you want the next one" : "Step done; the next one starts at the next check-in" };
    }
  }
  // Bounds, checked before anything new starts.
  if (goal.runsUsed >= goal.maxRuns) {
    return {
      kind: "ask",
      pause: true,
      blocker: { kind: "run_budget", text: `Used ${goal.runsUsed} of ${goal.maxRuns} runs for this goal. Continue to give it more.`, at: nowIso },
      nextAction: "Paused: run limit reached",
    };
  }
  if (goal.budgetMicroUsd !== null && goal.spentMicroUsd >= goal.budgetMicroUsd) {
    return {
      kind: "ask",
      pause: true,
      blocker: { kind: "spend_budget", text: "This goal has used its budget. Raise it to continue.", at: nowIso },
      nextAction: "Paused: budget used",
    };
  }
  if (goal.dueAt && goal.dueAt.getTime() < now.getTime()) {
    return {
      kind: "ask",
      pause: true,
      blocker: { kind: "overdue", text: "This goal is past its due date. Set a new date or drop it.", at: nowIso },
      nextAction: "Paused: past its due date",
    };
  }
  const attempt = (last ? last.attempt : 0) + 1;
  const stepTitle = step?.title ?? goal.title;
  return {
    kind: "start",
    stepKey,
    stepTitle,
    title: step ? `${goal.title}: ${step.title}`.slice(0, 120) : goal.title.slice(0, 120),
    prompt: composeGoalStepPrompt(goal, step),
    // One task per step per run-slot: two sweeps or a sweep and a press agree.
    idempotencyKey: `goal:${goal.id}:${stepKey}:${goal.runsUsed + 1}`,
    nextAction: attempt > 1 ? `Starting "${stepTitle}" again` : `Starting "${stepTitle}"`,
  };
}

// ---------------------------------------------------------------------------
// Met, or only run: the success criteria
// ---------------------------------------------------------------------------

/**
 * The status a goal takes when every milestone ran but its success criteria
 * were not shown to be met. Only the driver sets it; the person then marks it
 * met or keeps it going.
 */
export const GOAL_UNVERIFIED = "unverified";

/** What the final step's run concluded about the goal's criteria (src/lib/agents/goal-criteria.ts). */
export type GoalCriteriaVerdict = "met" | "not_met" | "unchecked";

export interface GoalCriteriaCheck {
  verdict: GoalCriteriaVerdict;
  /** One line from the check: why it passed, or the first criterion not shown. Null when it did not run. */
  why: string | null;
}

/** A stored check read back (an AgentEvent's detail); anything unreadable is null, never "met". */
export function readGoalCriteriaCheck(detail: unknown): GoalCriteriaCheck | null {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
  const row = detail as Record<string, unknown>;
  const verdict = row.verdict === "met" || row.verdict === "not_met" || row.verdict === "unchecked" ? row.verdict : null;
  if (!verdict) return null;
  return { verdict, why: typeof row.why === "string" && row.why.trim() ? oneLine(row.why, 300) : null };
}

/** The line a goal shows when every step ran and the check did not pass, or could not run. */
export const GOAL_UNVERIFIED_LINE = "Every step ran. Check the result.";

/**
 * Every milestone ran: is the goal met? Only when its success criteria were
 * checked and the check passed. Anything else (a NOT MET, a check that could
 * not run, a step that ran where no check could be made, such as a Mac) is
 * `unverified`, said in words, for the person to decide. Never fails open:
 * no check is never read as a pass. Pure: the driver applies it.
 */
export function planGoalCompletion(input: { title: string; check: GoalCriteriaCheck | null }): {
  status: "achieved" | typeof GOAL_UNVERIFIED;
  nextAction: string;
  event: { kind: "goal_achieved" | "goal_unverified"; title: string };
} {
  const { check } = input;
  if (check?.verdict === "met") {
    return {
      status: "achieved",
      nextAction: check.why ? `Met: every step ran and its criteria were checked. ${check.why}` : "Met: every step ran and its criteria were checked",
      event: { kind: "goal_achieved", title: `Met the goal: ${input.title}` },
    };
  }
  const nextAction =
    check?.verdict === "not_met"
      ? `${GOAL_UNVERIFIED_LINE} A check against its criteria found a gap${check.why ? `: ${check.why}` : "."}`
      : `${GOAL_UNVERIFIED_LINE} Its criteria could not be checked, so nothing says it is met yet.`;
  return {
    status: GOAL_UNVERIFIED,
    nextAction,
    event: { kind: "goal_unverified", title: `Every step of "${input.title}" ran. Check the result.` },
  };
}

/**
 * "Keep working" on an unverified goal: one more milestone, aimed at what the
 * check found missing (or at the criteria in general when it could not run),
 * so the driver has a concrete step rather than re-reading "every milestone
 * is done". Refused when the goal already has the most milestones it may.
 */
export function reopenUnverifiedGoal(
  milestones: readonly GoalMilestone[],
  gap: string | null
): { ok: true; milestones: GoalMilestone[] } | { ok: false; message: string } {
  if (milestones.length >= MAX_GOAL_MILESTONES) {
    return {
      ok: false,
      message: `This goal already has ${MAX_GOAL_MILESTONES} milestones. Tell the agent what is missing in its thread, or mark the goal met.`,
    };
  }
  const ids = new Set(milestones.map((m) => m.id));
  let n = 1;
  while (ids.has(`follow_up_${n}`)) n += 1;
  const title = gap ? oneLine(`Close the gap the check found: ${gap}`, 160) : "Show that every success criterion is met";
  return { ok: true, milestones: [...milestones, { id: `follow_up_${n}`, title, done: false, sessionId: null, doneAt: null }] };
}

/** Whether the step a run is working on is the goal's last one left: the run that may check its criteria. */
export function isFinalGoalStep(milestones: readonly GoalMilestone[], stepKey: string | null | undefined): boolean {
  if (!stepKey || stepKey === GOAL_NEXT_STEP_KEY || milestones.length === 0) return false;
  const left = milestones.filter((m) => !m.done);
  return left.length === 1 && left[0]!.id === stepKey;
}

/** The milestone that finished last: its run is the one that checked the criteria. */
export function lastFinishedMilestone(milestones: readonly GoalMilestone[]): GoalMilestone | null {
  let latest: GoalMilestone | null = null;
  for (const m of milestones) {
    if (!m.done || !m.sessionId) continue;
    if (!latest || (m.doneAt ?? "") >= (latest.doneAt ?? "")) latest = m;
  }
  return latest;
}

/** One step's result as the criteria check reads it. */
export interface GoalStepResult {
  title: string;
  /** The run's final answer, or null when none was written. */
  answer: string | null;
  /** Titles of the files it produced. */
  artifacts: readonly string[];
}

/** Per step, and in all: the check reads what was produced, not every word of it. */
export const GOAL_CHECK_STEP_CHARS = 1_500;
export const GOAL_CHECK_TOTAL_CHARS = 8_000;

/** What the goal's steps produced, bounded, for the criteria check. */
export function composeGoalDeliverables(steps: readonly GoalStepResult[]): string {
  const blocks = steps.map((step) => {
    const answer = step.answer?.trim() ? step.answer.trim() : "(no written answer)";
    const clipped = answer.length > GOAL_CHECK_STEP_CHARS ? `${answer.slice(0, GOAL_CHECK_STEP_CHARS - 1)}…` : answer;
    const files = step.artifacts.length ? `\nFiles: ${step.artifacts.slice(0, 10).join(", ")}` : "";
    return `## ${step.title}\n${clipped}${files}`;
  });
  const text = blocks.join("\n\n");
  return text.length > GOAL_CHECK_TOTAL_CHARS ? `${text.slice(0, GOAL_CHECK_TOTAL_CHARS - 1)}…` : text;
}

/** Milestones after a step's task completed. */
export function markMilestoneDone(milestones: readonly GoalMilestone[], stepKey: string, sessionId: string, now = new Date()): GoalMilestone[] {
  return milestones.map((m) => (m.id === stepKey ? { ...m, done: true, sessionId, doneAt: now.toISOString() } : m));
}

/** One sentence for the goal's row: progress and what is next. */
export function goalSummarySentence(goal: { milestones: readonly GoalMilestone[]; status: string; nextAction: string | null; runsUsed: number; maxRuns: number }): string {
  const total = goal.milestones.length;
  const done = goal.milestones.filter((m) => m.done).length;
  const parts: string[] = [];
  if (total) parts.push(`${done} of ${total} milestones`);
  if (goal.nextAction) parts.push(goal.nextAction);
  if (goal.status === "active" && goal.runsUsed > 0) parts.push(`${goal.runsUsed} of ${goal.maxRuns} runs used`);
  return parts.join(" · ");
}

import type { WorkPermissionPolicy } from "@/lib/work/domain";

/**
 * Whether a run shows its plan to the reader before it acts on it.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * The plan is the model's first tool call (`write_plan`), and until now the run
 * carried straight on from it. Everything before the press is a guess about the
 * work — the pre-flight card's two or three questions, the one-line disclosure
 * — and the first thing that is not a guess, the plan itself, was the one thing
 * the reader never got to see before something was done about it. Deep research
 * already has this gate ("Planning stops at awaiting_plan_confirmation"); Work
 * did not.
 *
 * ── Why the approval mode decides it, and not a new switch ──────────────────
 *
 * A second control beside the approval chip would ask the reader the same
 * question twice in two vocabularies. `conservative` already means "ask before
 * every change", and a plan is the list of changes: a reader who chose that
 * mode has already said, in the product's own words, that they want to see what
 * is coming before it happens. `balanced` and `permissive` said the opposite,
 * and gating them would be overriding an answer they gave on purpose.
 *
 * ── Why an unattended run never parks here ─────────────────────────────────
 *
 * There is nobody to answer. A question from an unattended run checkpoints it
 * and releases the worker (see the runner's `askQuestion`), so a plan gate on a
 * schedule firing at 03:00 would not be a review — it would be every scheduled
 * run stopping on its first step until somebody happened to open the app. The
 * clock is suspended while it waits, so this costs the reader nothing but it
 * costs them the run.
 *
 * Pure and free of `server-only` so both the dispatch side and a test can read
 * the same rule; the executor's own copy of the decision is this function's
 * result, passed through `WorkSessionOptions.confirmPlan`.
 */
export function confirmPlanBeforeActing(input: {
  /** The resolved mode, after narrowing by host, project, schedule and session. */
  policy: WorkPermissionPolicy;
  /** False when the run was started by a schedule, a trigger or a resume. */
  attended: boolean;
}): boolean {
  if (!input.attended) return false;
  return input.policy === "conservative";
}

/**
 * The reserved id the plan question is asked under.
 *
 * A question id is normally the tool call's own id, which is opaque and
 * different every time. This one is fixed so a client can recognise the
 * question as the plan review and draw it as the plan rather than as a
 * free-text prompt.
 *
 * Fixing it is safe, and the reason is worth stating because it is the first
 * thing a reviewer will ask. Only the first plan write is gated, so one session
 * asks it once. A run that parked here and was resumed on another worker starts
 * its write counter again and can therefore reach the gate a second time — and
 * that resolves immediately rather than waiting, because the answer is already
 * in the log under this id and `pollAnswer` finds it. The answer route's own
 * event key is `answer:<questionId>`, so the reader cannot answer the same
 * review twice either: the second is dropped as a duplicate before it takes a
 * sequence number. Both of those are the behaviour a fixed id should have.
 */
export const PLAN_REVIEW_QUESTION_ID = "plan-review";

/** The two answers the question offers. Anything else is read as a change. */
export const PLAN_REVIEW_APPROVE = "Go ahead";
export const PLAN_REVIEW_REVISE = "Change it";

/**
 * Whether an answer to the plan question was "get on with it".
 *
 * Exact match on the offered option, and everything else — including
 * "Change it" and including a sentence the reader typed instead of pressing
 * either button — is a revision. Failing this way round is the safe one: a run
 * that reads a vague answer as approval has acted on a plan nobody approved,
 * while one that reads it as a revision spends one more model turn.
 */
export function planReviewApproved(answer: string): boolean {
  return answer.trim() === PLAN_REVIEW_APPROVE;
}

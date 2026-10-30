import "server-only";
import { prisma } from "@/lib/prisma";
import { answeredQuestionWhere, answerTextFromPayload } from "@/lib/work/answer-lookup";
import {
  abandonedApprovalDecision,
  answerMissedByRestart,
  approvalIdOfRequestEvent,
  approvalRequestIdFor,
  askedQuestionId,
  deriveQuestionState,
  isCloudExecutionStart,
  planParkedDecisions,
  type ParkedCallRef,
  type ParkedDecisions,
  type ParkedResolution,
  type QuestionState,
  type RecordedApproval,
} from "@/lib/work/park-resume-rules";

export {
  APPROVED_WHILE_PARKED,
  DECLINED_WHILE_PARKED,
  DEFAULT_ATTENDED_WAIT_MS,
  DEFAULT_MAX_PARKED_RUNS_PER_ACCOUNT,
  EXPIRED_WHILE_PARKED,
  ParkedDecisions,
  attendedWaitMs,
  deriveQuestionState,
  judgeRecordedApproval,
  maxParkedRunsPerAccount,
  type ParkedCallRef,
  type ParkedResolution,
  type QuestionState,
} from "@/lib/work/park-resume-rules";

/*
 * "Needs you" after a run has been set aside.
 *
 * A cloud run that asks a question or an approval waits a short while with its
 * executor attached (`attendedWaitMs`), then parks: `paused`, `pauseReason:
 * "waiting"`, lease released, checkpoint saved (store.ts `parkRun`). Three
 * things make the answer that arrives afterwards count:
 *
 *   1. The answer or decision is recorded AND the run is put back in the queue
 *      (`requeueParkedRun` in store.ts, called by the answer and decision
 *      routes). `questionState` is how the answer route tells an open question
 *      from one that is answered or belongs to an execution that has ended.
 *
 *   2. When the run is claimed again, the call it parked on is given what the
 *      person said (`loadParkedDecisions`, then the runtime's
 *      `settleParkedCalls`), so the model reads the answer as the call's own
 *      result and the person answers once.
 *
 *   3. If the model asks the same thing again anyway, the recorded answer or
 *      decision satisfies it once (`ParkedDecisions`). An approval only when the
 *      action digest matches, the policy is the one it was given under, and
 *      the decision has not expired — the stored digest and the stored expiry,
 *      never relaxed. Anything else asks again.
 *
 * Two edges close the loop. An answer that lands between the executor's last
 * poll and its park finds the run still attached, so the route leaves it; the
 * executor checks once more after parking (`parkedWaitAnswered`) and requeues
 * it itself. And a request an ended execution left pending is closed when the
 * next execution starts (`closeAbandonedApprovals`), so a stale card cannot be
 * answered into nothing; a decision moves the run only when it is on the
 * request the run waits on (`openWait`).
 *
 * The rules are pure and live in park-resume-rules.ts; this file is the reads
 * that feed them. Mac runs are not parked by this path (the Mac holds its own
 * wait) and are not touched by any of it.
 */

/** The state of one question on one run, read from its event log. */
export async function questionState(input: {
  runId: string;
  userId: string;
  questionId: string;
}): Promise<QuestionState> {
  const events = await prisma.workEvent.findMany({
    where: {
      runId: input.runId,
      userId: input.userId,
      kind: { in: ["question_asked", "question_answered", "run_started"] },
    },
    orderBy: { seq: "asc" },
    select: { seq: true, kind: true, payload: true },
  });
  return deriveQuestionState(events, input.questionId);
}

/**
 * Whether the answer just written at `answerSeq` reached the run after a newer
 * cloud execution of it had started (`answerMissedByRestart`): nothing reads
 * it, and the route must not say the run carries on with it.
 */
export async function answerArrivedAfterRestart(input: {
  runId: string;
  userId: string;
  questionId: string;
  answerSeq: number;
}): Promise<boolean> {
  const events = await prisma.workEvent.findMany({
    where: {
      runId: input.runId,
      userId: input.userId,
      kind: { in: ["question_asked", "run_started"] },
      seq: { lt: input.answerSeq },
    },
    orderBy: { seq: "asc" },
    select: { seq: true, kind: true, payload: true },
  });
  return answerMissedByRestart(events, input.questionId, input.answerSeq);
}

/**
 * What a resumed run's parked calls get, read from the database once, before
 * the run continues.
 *
 * A question gets its recorded answer (the `question_answered` row the answer
 * route wrote). Any other call gets the decision on the approval requested for
 * that very call — found through the `approval_requested` event that names
 * both the runtime's request id (`<runId>:<callId>`) and the row — when that
 * decision can still be used: an approval is told it was approved and must
 * call the tool again (where the gate checks the decision for real), a denial
 * is told it was declined, a lapsed request is told it expired. A pending or
 * re-scoped approval resolves nothing, and the call asks again.
 */
export async function loadParkedDecisions(input: {
  runId: string;
  userId: string;
  calls: readonly ParkedCallRef[];
  askToolName: string;
  policy: unknown;
  now: Date;
}): Promise<{ resolutions: Map<string, ParkedResolution>; decisions: ParkedDecisions }> {
  // The first answer, as everywhere else (`deriveQuestionState`,
  // `pollAnswer`): the route refuses a different second one, so there is one
  // to read. And not one written after a newer execution had started (this
  // one: the executor writes its `run_started` before it restores the run):
  // that answer lost the race described at `answerMissedByRestart`, and the
  // answer route tells its author the run will ask again. Both sides apply
  // the same rule to the same rows, so that sentence never depends on a few
  // milliseconds.
  const asks = input.calls.filter((call) => call.name === input.askToolName);
  const askEvents = asks.length === 0 ? [] : await prisma.workEvent.findMany({
    where: { runId: input.runId, userId: input.userId, kind: { in: ["question_asked", "run_started"] } },
    orderBy: { seq: "asc" },
    select: { seq: true, kind: true, payload: true },
  });
  const answers = new Map<string, string>();
  for (const call of asks) {
    const event = await prisma.workEvent.findFirst({
      where: { ...answeredQuestionWhere(input.runId, call.id), userId: input.userId },
      orderBy: { seq: "asc" },
      select: { seq: true, payload: true },
    });
    if (!event || answerMissedByRestart(askEvents, call.id, event.seq)) continue;
    const text = answerTextFromPayload(event.payload, call.id);
    if (text !== null) answers.set(call.id, text);
  }

  const approvals = new Map<string, RecordedApproval>();
  for (const call of input.calls) {
    if (call.name === input.askToolName) continue;
    const requested = await prisma.workEvent.findFirst({
      where: {
        runId: input.runId,
        userId: input.userId,
        kind: "approval_requested",
        payload: { path: ["request", "id"], equals: approvalRequestIdFor(input.runId, call.id) },
      },
      orderBy: { seq: "desc" },
      select: { payload: true },
    });
    const approvalId = requested ? approvalIdOfRequestEvent(requested.payload) : null;
    if (approvalId === null) continue;
    const row = await prisma.workApproval.findFirst({
      where: { id: approvalId, runId: input.runId, userId: input.userId },
      select: {
        id: true,
        action: true,
        actionDigest: true,
        policyDigest: true,
        decision: true,
        expiresAt: true,
        detail: true,
      },
    });
    if (row) approvals.set(call.id, row);
  }

  return planParkedDecisions({
    calls: input.calls,
    askToolName: input.askToolName,
    answers,
    approvals,
    policy: input.policy,
    now: input.now,
  });
}

/**
 * Closes the approval requests a run's earlier execution left pending, as a new
 * cloud execution of it starts.
 *
 * Nobody is waiting on them any more: the execution that asked has ended, and
 * the restored run either was handed a decision (the route requeued it after
 * recording one, so it is not pending), or asks again under a new request. Left
 * pending, an old card kept its buttons and the decision route took a decision
 * on it that nothing would ever read — and, for a run waiting on a newer
 * request, cleared its "needs you" while the newer one was still open.
 *
 * Compare-and-set per row on `decision: "pending"`, so a decision recorded at
 * the same moment wins or loses cleanly: it is either in the row before this
 * reads it (and the restored run is handed it) or refused afterwards as
 * already resolved. Returns the rows it closed and what they became, for the
 * executor to put on the run's timeline so every client closes the card.
 */
export async function closeAbandonedApprovals(input: {
  runId: string;
  userId: string;
  now: Date;
}): Promise<Array<{ approvalId: string; decision: "expired" | "superseded" }>> {
  const pending = await prisma.workApproval.findMany({
    where: { runId: input.runId, userId: input.userId, decision: "pending" },
    select: { id: true, expiresAt: true },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  const closed: Array<{ approvalId: string; decision: "expired" | "superseded" }> = [];
  for (const row of pending) {
    const decision = abandonedApprovalDecision(row.expiresAt, input.now);
    const moved = await prisma.workApproval.updateMany({
      where: { id: row.id, userId: input.userId, decision: "pending" },
      data: { decision, decidedAt: input.now },
    });
    if (moved.count === 1) closed.push({ approvalId: row.id, decision });
  }
  return closed;
}

/** What a cloud run was waiting on when it parked. */
export type ParkedWait = { kind: "question"; questionId: string } | { kind: "approval"; approvalId: string };

/**
 * Whether what a run parked on has been answered or decided already.
 *
 * The executor asks this right after it parks, because the answer can land in
 * the gap between its last poll and the park: the route then still saw the run
 * attached and left the requeue to the executor, which has stopped polling. Read
 * after the park is committed, so one of the two always sees the other — the
 * route reads the run after writing the answer, the executor reads the answer
 * after writing the park.
 */
export async function parkedWaitAnswered(input: { runId: string; userId: string; wait: ParkedWait }): Promise<boolean> {
  if (input.wait.kind === "question") {
    const event = await prisma.workEvent.findFirst({
      where: { ...answeredQuestionWhere(input.runId, input.wait.questionId), userId: input.userId },
      select: { payload: true },
    });
    return event !== null && answerTextFromPayload(event.payload, input.wait.questionId) !== null;
  }
  const row = await prisma.workApproval.findFirst({
    where: { id: input.wait.approvalId, runId: input.runId, userId: input.userId },
    select: { decision: true },
  });
  return row !== null && row.decision !== "pending";
}

/**
 * What a cloud run is waiting on, read from its event log: the newest
 * question or approval request asked since its latest cloud execution started,
 * or null when that execution has asked nothing yet.
 *
 * A run waits on one thing at a time: it asks, waits, and either reads the
 * answer and moves on (asking anything later under a newer event) or parks on
 * that very ask. So for a run that is parked waiting, this is what it parked
 * on, and a decision on any other request answers nothing the run will read.
 * An approval is named by the row id the executor writes on its
 * `approval_requested` event; an event without one (written before the
 * executor named its rows) names nothing, and nothing is requeued for it.
 */
export async function openWait(input: { runId: string; userId: string }): Promise<ParkedWait | null> {
  const events = await prisma.workEvent.findMany({
    where: {
      runId: input.runId,
      userId: input.userId,
      kind: { in: ["run_started", "question_asked", "approval_requested"] },
    },
    orderBy: { seq: "desc" },
    take: 20,
    select: { kind: true, payload: true },
  });
  for (const event of events) {
    if (isCloudExecutionStart(event.kind, event.payload)) return null;
    if (event.kind === "question_asked") {
      const questionId = askedQuestionId(event.payload);
      return questionId === null ? null : { kind: "question", questionId };
    }
    if (event.kind === "approval_requested") {
      const approvalId = approvalIdOfRequestEvent(event.payload);
      return approvalId === null ? null : { kind: "approval", approvalId };
    }
  }
  return null;
}

/** Whether a cloud run is waiting on this approval request (`openWait`). */
export async function waitsOnApproval(input: { runId: string; userId: string; approvalId: string }): Promise<boolean> {
  const wait = await openWait(input);
  return wait?.kind === "approval" && wait.approvalId === input.approvalId;
}

/**
 * A run's row as it is now, as much as deciding what an answer or a decision
 * does next needs. The routes read it again after writing, never trusting the
 * row they read before (see `parkedWaitAnswered` for the race this closes).
 */
export async function currentRunState(input: { runId: string; userId: string }): Promise<{
  id: string;
  sessionId: string;
  status: string;
  pauseReason: string | null;
  hostId: string | null;
  effectiveTarget: string | null;
} | null> {
  return prisma.workRun.findFirst({
    where: { id: input.runId, userId: input.userId },
    select: { id: true, sessionId: true, status: true, pauseReason: true, hostId: true, effectiveTarget: true },
  });
}

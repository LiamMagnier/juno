import "server-only";
import { prisma } from "@/lib/prisma";
import { answeredQuestionWhere, answerTextFromPayload } from "@/lib/work/answer-lookup";
import {
  deriveQuestionState,
  planParkedDecisions,
  type ParkedCallRef,
  type ParkedDecisions,
  type ParkedResolution,
  type QuestionState,
} from "@/lib/work/park-resume-rules";

export {
  APPROVED_WHILE_PARKED,
  DECLINED_WHILE_PARKED,
  DEFAULT_ATTENDED_WAIT_MS,
  DEFAULT_MAX_PARKED_RUNS_PER_ACCOUNT,
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
 * What a resumed run's parked calls get, read from the database once, before
 * the run continues.
 *
 * A question gets its recorded answer (the `question_answered` row the answer
 * route wrote). Any other call gets the newest decision on an approval for the
 * same tool and input, when that decision can still be used: an approval is
 * told it was approved and must call the tool again (where the gate checks the
 * decision for real), a denial is told it was declined. A pending, expired or
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
  const answers = new Map<string, string>();
  for (const call of input.calls) {
    if (call.name !== input.askToolName) continue;
    const event = await prisma.workEvent.findFirst({
      where: { ...answeredQuestionWhere(input.runId, call.id), userId: input.userId },
      orderBy: { seq: "desc" },
      select: { payload: true },
    });
    const text = event ? answerTextFromPayload(event.payload, call.id) : null;
    if (text !== null) answers.set(call.id, text);
  }

  const approvals = input.calls.some((call) => call.name !== input.askToolName)
    ? await prisma.workApproval.findMany({
        where: { runId: input.runId, userId: input.userId },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true,
          action: true,
          actionDigest: true,
          policyDigest: true,
          decision: true,
          expiresAt: true,
          detail: true,
        },
      })
    : [];

  return planParkedDecisions({
    calls: input.calls,
    askToolName: input.askToolName,
    answers,
    approvals,
    policy: input.policy,
    now: input.now,
  });
}

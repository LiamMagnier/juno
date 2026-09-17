/*
 * Finding the answer to ONE question in a run's append-only event log.
 *
 * Pure and free of `server-only` so the cloud executor and a test can read the
 * same rule; the executor supplies the Prisma client, this file supplies what
 * to ask it for and how to read what comes back.
 *
 * ── The stall this exists to prevent ────────────────────────────────────────
 *
 * The obvious query — newest `question_answered` row for the run, then check
 * its `questionId` — is wrong whenever the run answered a different question
 * more recently than the one being polled. That never mattered while every
 * question id was its tool call's id, because a replayed attempt minted a fresh
 * id and asked again. The plan review is asked under a fixed id, and a fixed id
 * turns the same mismatch into a permanent stall: the poll reads whichever
 * question was answered last, sees a different id, returns null, and the run
 * parks on its plan gate again. The reader presses "Go ahead" a second time and
 * the answer route writes it under the event key `answer:<questionId>` — the
 * same key as the first press, on the same re-claimed run — so `appendEvents`
 * drops it as a duplicate before it takes a sequence number. From then on every
 * press returns 200 and changes nothing, and the run never leaves the gate.
 *
 * So the poll has to select the answer it was actually asked for. Filtering on
 * the payload rather than testing the newest row is what makes the fixed id
 * safe: a plan review answered on attempt one is still found on attempt four,
 * resolves immediately, and is never asked a second time.
 */

/**
 * The rows that answer this exact question.
 *
 * The `questionId` test lives in the WHERE clause on purpose. Fetching a window
 * of recent answers and filtering in memory would work for a run with a handful
 * of questions and quietly stop working for a long conservative run that asked
 * more of them than the window holds — and that failure would look exactly like
 * the stall above rather than like a missing row.
 */
export function answeredQuestionWhere(
  runId: string,
  questionId: string
): {
  runId: string;
  kind: string;
  payload: { path: string[]; equals: string };
} {
  return {
    runId,
    kind: "question_answered",
    payload: { path: ["questionId"], equals: questionId },
  };
}

/**
 * The text of an answer, or null when the row is not an answer to this question.
 *
 * Both spellings are accepted and `text` wins. The answer route writes `text`;
 * rows written before it did carry `answer`, and WorkEvent is append-only, so a
 * reader that understood only one spelling would make every older row
 * unreadable.
 *
 * The `questionId` is re-checked here even though the query already filtered on
 * it, because this is the only place that knows what a well-formed answer
 * payload looks like, and a caller that hands it the wrong row should get null
 * rather than somebody else's reply.
 */
export function answerTextFromPayload(payload: unknown, questionId: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as { questionId?: unknown; text?: unknown; answer?: unknown };
  if (record.questionId !== questionId) return null;
  if (typeof record.text === "string") return record.text;
  return typeof record.answer === "string" ? record.answer : null;
}

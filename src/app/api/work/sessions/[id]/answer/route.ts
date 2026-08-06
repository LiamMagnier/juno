import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import {
  WORK_STEERING_EVENT_KIND,
  isTerminalStatus,
  workSteeringPayload,
} from "@/lib/work/domain";
import {
  appendEvents,
  dispatchRunCommand,
  setSessionAttention,
  type DispatchRunCommandResult,
} from "@/lib/work/store";
import { runCommandKey } from "@/lib/work/relay";
import { answerSchema } from "@/app/api/work/protocol";

export const runtime = "nodejs";

/**
 * Two requests share this route: answering the question a run asked, and saying
 * something to a run that has not asked anything.
 *
 * They are told apart by `questionId` and validated separately, rather than by
 * one schema with the id made optional. An answer without an id is not a
 * lenient answer, it is a different request with different preconditions — the
 * answer needs a run that is waiting for one, the instruction needs a run that
 * is not — and a single schema would leave both branches re-deriving which of
 * the two arrived.
 *
 * `answerSchema` stays exactly as `protocol.ts` declares it, so the shape the
 * native clients are written against is unchanged by any of this.
 */
const MAX_INSTRUCTION_CHARS = 10_000;
const MAX_ID_CHARS = 200;

const steerSchema = z.object({
  text: z.string().trim().min(1).max(MAX_INSTRUCTION_CHARS),
  idempotencyKey: z.string().trim().min(8).max(MAX_ID_CHARS).optional(),
});

/**
 * What the caller is told when the instruction reached the thing doing the work.
 *
 * One sentence for both executors, now that both really do read it. The cloud
 * runner drains unconsumed steering events between turns and appends them as a
 * user turn; the Mac is handed a `steer` command over the relay and
 * `DesktopWorkRunHost` queues it for the top of its next turn. Neither aborts
 * the turn in flight, so "what it has already done stands" is true on both, and
 * a person should not have to know which one their task landed on to know what
 * happens next.
 *
 * A run that has not been dispatched yet has no effective target and is treated
 * as cloud, which is right: it will be claimed by whichever executor the
 * dispatch picks, and the instruction is in the log before the first turn
 * either way.
 */
const STEER_DELIVERED =
  "Juno reads this before its next step and works to it from there. What it has already done " +
  "stands.";

/**
 * What the caller is told when it did not.
 *
 * Only two things can stop it now, and both are about the Mac rather than about
 * steering: the run's host row is gone, or the relay refused the instruction —
 * a revoked Mac, Work switched off on it, or a build too old to parse `steer`.
 * The refusal already carries a sentence written for the person reading it, so
 * it is quoted rather than paraphrased; anything else would give one failure two
 * wordings depending on which surface reported it.
 */
const STEER_HOST_GONE =
  "Kept on this task’s record. The Mac this attempt is running on is no longer paired with your " +
  "account, so there was nothing left to tell.";

function steerNotDelivered(reason: string): string {
  return `${reason} It is kept on this task’s record.`;
}

/** One submitted body, already told apart and already validated. */
type Submission =
  | { kind: "answer"; questionId: string; text: string; idempotencyKey?: string }
  | { kind: "instruction"; text: string; idempotencyKey?: string };

/**
 * Which of the two arrived, and whether it is well formed.
 *
 * The presence of the key decides, not its validity: a body carrying a
 * `questionId` that is too long is a malformed ANSWER and is refused as one,
 * rather than falling through to be recorded as an unprompted instruction under
 * the id the caller meant to answer.
 */
function parseSubmission(raw: unknown): Submission | null {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw) && "questionId" in raw) {
    const parsed = answerSchema.safeParse(raw);
    return parsed.success ? { kind: "answer", ...parsed.data } : null;
  }
  const parsed = steerSchema.safeParse(raw);
  return parsed.success ? { kind: "instruction", ...parsed.data } : null;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  // Validated before anything is read, exactly as this route always has: a body
  // this surface would not accept is a 400 about the request rather than a 404
  // about a session the caller may well own.
  const submission = parseSubmission(await req.json().catch(() => null));
  if (submission === null) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const session = await prisma.workSession.findFirst({
    where: { id, userId: user.id, deletedAt: null },
    select: { id: true },
  });
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const run = await prisma.workRun.findFirst({
    where: { sessionId: session.id, userId: user.id },
    orderBy: { attempt: "desc" },
    select: { id: true, status: true, hostId: true, effectiveTarget: true },
  });

  return submission.kind === "answer"
    ? recordAnswer({ submission, sessionId: session.id, userId: user.id, run })
    : recordInstruction({ submission, sessionId: session.id, userId: user.id, run });
}

interface Target<T> {
  submission: T;
  userId: string;
  run: { id: string; status: string; hostId: string | null; effectiveTarget: string | null } | null;
}

async function recordAnswer({
  submission,
  sessionId,
  userId,
  run,
}: Target<Extract<Submission, { kind: "answer" }>> & { sessionId: string }) {
  const { questionId, text, idempotencyKey } = submission;

  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Only a run that is actually waiting takes an answer. Appending one to a
  // run that has moved on puts the user's words into a transcript at a point
  // where nothing asked for them, and — worse — reads as an answer to whatever
  // the run asks next.
  if (run.status !== "waiting_input") {
    return NextResponse.json(
      {
        error: "run_not_waiting_input",
        message: "This run is not waiting for an answer.",
        status: run.status,
      },
      { status: 409 }
    );
  }

  // The event key defaults to the question rather than to a random value, so a
  // client that retries without minting a key still answers once. `appendEvents`
  // drops the duplicate before allocating a seq, so a retry leaves no hole in
  // the sequence the stream cursor reads.
  const appended = await appendEvents({
    runId: run.id,
    userId,
    events: [
      {
        kind: "question_answered",
        payload: { questionId, text, answeredVia: "web" },
        key: idempotencyKey ?? `answer:${questionId}`,
      },
    ],
  });

  // Tell the Mac, if a Mac is the one waiting. The cloud runner finds the
  // answer by polling the log, but a local run is blocked inside the host
  // app's approval coordinator, which reads nothing — so without this the
  // answer sat in the transcript and the run waited until it timed out. The
  // key is derived from the question, so a retried answer resolves to the one
  // command rather than queueing a second.
  await dispatchRunCommand({
    userId,
    sessionId,
    runId: run.id,
    hostId: run.hostId,
    effectiveTarget: run.effectiveTarget,
    kind: "answer",
    payload: { questionId, text },
    idempotencyKey: runCommandKey(run.id, "answer", questionId),
  });

  // The status stays `waiting_input` — the executor owns that transition and
  // moves it when it picks the answer up. What changes here is attention: the
  // user has done their part, and a session that keeps demanding it after they
  // have answered is how a "Needs attention" list stops being believed.
  await setSessionAttention({
    sessionId,
    userId,
    status: "waiting_input",
    needsAttention: false,
  });

  return NextResponse.json({
    lastSeq: appended.lastSeq,
    replay: appended.duplicates > 0,
  });
}

/**
 * Records an instruction the run did not ask for, and hands it to the executor.
 *
 * Both executors, now. The cloud runner finds the row by polling the log, and a
 * Mac is told with a `steer` command over the relay — the same shape an answer
 * has used since the day a local run was found waiting for one that was sitting
 * in a transcript nobody local was reading. Until that command existed this
 * route answered a local steer with `delivered: false` and a sentence saying the
 * Mac app is handed its instructions at run start and never re-reads them, which
 * was true and is the thing that has changed.
 *
 * The event is written as `user_message`, which is a member of
 * `WORK_EVENT_KINDS` now that domain.ts owns one. It used to ride
 * `question_answered` with a `steering` marker and no `questionId`, because a
 * route could not add to a vocabulary the Mac and the phone share; the payload
 * keeps that shape exactly — see `workSteeringPayload` — so the rows already in
 * the log and the ones an older client still writes read identically, and
 * `steeringInstruction` accepts both.
 *
 * A run that IS waiting on a question is still refused, but the reason has
 * changed and it is worth being precise about which one now applies. It is no
 * longer a mechanism: `pollAnswer` reads the newest `question_answered` row, and
 * a `user_message` is not one, so an instruction can no longer mask an answer.
 * It is that the run is stopped. An instruction accepted here would sit in the
 * log until somebody answered the question, and the user would have been told
 * their words were delivered to a run that had not moved.
 */
async function recordInstruction({
  submission,
  sessionId,
  userId,
  run,
}: Target<Extract<Submission, { kind: "instruction" }>> & { sessionId: string }) {
  const { text, idempotencyKey } = submission;

  if (!run) {
    return NextResponse.json(
      {
        error: "run_not_started",
        message:
          "This task has never been started, so there is no attempt for an instruction to join. " +
          "Start it, and everything in the goal goes with it.",
      },
      { status: 409 }
    );
  }
  if (run.status === "waiting_input") {
    return NextResponse.json(
      {
        error: "answer_expected",
        message:
          "Juno is waiting for an answer to the question it asked, and nothing else will restart " +
          "it. Answer that, and say the rest of this in the same reply.",
        status: run.status,
      },
      { status: 409 }
    );
  }
  if (isTerminalStatus(run.status)) {
    return NextResponse.json(
      {
        error: "run_finished",
        message: "This attempt has finished. Start it again to say more.",
        status: run.status,
      },
      { status: 409 }
    );
  }

  // No default key, unlike the answer above. There is nothing here to derive a
  // stable one from, and two identical sentences typed a minute apart are two
  // deliberate instructions rather than one delivered twice — a key invented
  // from the text would swallow the second. A client that wants a lost response
  // to be safe to retry sends its own.
  const appended = await appendEvents({
    runId: run.id,
    userId,
    events: [
      {
        kind: WORK_STEERING_EVENT_KIND,
        payload: { ...workSteeringPayload(text, "web") },
        ...(idempotencyKey === undefined ? {} : { key: `steer:${idempotencyKey}` }),
      },
    ],
  });

  // Tell the Mac, if a Mac is the one working. `dispatchRunCommand` answers
  // `skipped: not_local` for a cloud run, which is the whole of the cloud path
  // here: the runner is already reading the row that was just written and there
  // is no machine to instruct.
  //
  // The command's key is derived, never random, or a client retrying a lost
  // response would queue a second instruction against a run that had already
  // been given the first. It is derived from exactly what deduplicated the event
  // above, so the two agree by construction: the caller's key when it sent one,
  // and otherwise the seq of the row that was just written — which `lastSeq` is,
  // because a keyless event is never dropped as a duplicate, so this append was
  // one row and the run's sequence now ends at it.
  const occurrence = idempotencyKey ?? appended.lastSeq;
  const dispatch = await dispatchRunCommand({
    userId,
    sessionId,
    runId: run.id,
    hostId: run.hostId,
    effectiveTarget: run.effectiveTarget,
    kind: "steer",
    payload: { text },
    idempotencyKey: runCommandKey(run.id, "steer", occurrence),
  });

  // Attention is deliberately not touched. Nothing was demanded of the user, so
  // nothing about their having spoken says the run has stopped needing them —
  // and clearing the flag here would take a task off the "Needs you" list on the
  // strength of a sentence that answered nothing.
  return NextResponse.json({
    lastSeq: appended.lastSeq,
    replay: appended.duplicates > 0,
    ...steerOutcome(dispatch),
  });
}

/**
 * `delivered`, and the sentence that goes with it, read off what the dispatch
 * actually did rather than off the run's target.
 *
 * The target alone was enough to answer this while the answer was "cloud yes,
 * Mac no". It is not enough now: a local run whose Mac is revoked, switched off
 * or too old to parse `steer` gets a queued instruction for nobody, and telling
 * its owner that Juno reads this before its next step would be the same lie in
 * a new place. Refusing at enqueue is what makes that knowable here, while the
 * person who typed the sentence is still waiting on the response.
 */
function steerOutcome(dispatch: DispatchRunCommandResult): {
  delivered: boolean;
  explanation: string;
} {
  switch (dispatch.status) {
    case "queued":
      return { delivered: true, explanation: STEER_DELIVERED };
    case "skipped":
      return dispatch.why === "not_local"
        ? { delivered: true, explanation: STEER_DELIVERED }
        : { delivered: false, explanation: STEER_HOST_GONE };
    case "refused":
      return { delivered: false, explanation: steerNotDelivered(dispatch.refusal.message) };
  }
}

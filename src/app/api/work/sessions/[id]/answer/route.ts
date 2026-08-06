import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import {
  WORK_STEERING_EVENT_KIND,
  isTerminalStatus,
  workSteeringPayload,
} from "@/lib/work/domain";
import { appendEvents, dispatchRunCommand, setSessionAttention } from "@/lib/work/store";
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
 * What the caller is told about an instruction that was not an answer.
 *
 * Two sentences, because there are two truths and which one applies depends on
 * who is executing. The cloud runner reads unconsumed steering events between
 * turns and puts them in front of the model as a user turn, so for a cloud run
 * this really is delivered and saying so is not a courtesy. A run on a Mac is
 * driven by the host app over the relay, which has no such reader yet; claiming
 * delivery there would be the same lie this response was written to avoid, in
 * the opposite direction.
 *
 * The distinction is drawn on `effectiveTarget` rather than on hope. A run that
 * has not been dispatched yet has no effective target and is treated as cloud,
 * which is right: it will be claimed by whichever executor the dispatch picks,
 * and the instruction is in the log before the first turn either way.
 */
const STEER_DELIVERED =
  "Juno reads this before its next step and works to it from there. What it has already done " +
  "stands.";

const STEER_RECORDED_ONLY =
  "Kept on this task’s record. This attempt is running on your Mac, and the Mac app is handed " +
  "its instructions when a run starts rather than re-reading them, so this does not redirect " +
  "what it is doing now.";

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
    : recordInstruction({ submission, userId: user.id, run });
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
  userId,
  run,
}: Target<Extract<Submission, { kind: "instruction" }>>) {
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

  // Attention is deliberately not touched. Nothing was demanded of the user, so
  // nothing about their having spoken says the run has stopped needing them —
  // and clearing the flag here would take a task off the "Needs you" list on the
  // strength of a sentence that answered nothing.
  const delivered = run.effectiveTarget !== "local";
  return NextResponse.json({
    lastSeq: appended.lastSeq,
    replay: appended.duplicates > 0,
    delivered,
    explanation: delivered ? STEER_DELIVERED : STEER_RECORDED_ONLY,
  });
}

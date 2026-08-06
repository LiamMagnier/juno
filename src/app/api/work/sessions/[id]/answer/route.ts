import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { isTerminalStatus } from "@/lib/work/domain";
import { appendEvents, setSessionAttention } from "@/lib/work/store";
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
 * Stated in the response rather than left for a client to assume, because the
 * assumption every client would make is the wrong one. The instruction is
 * appended to the run's transcript and nothing on the executing side re-reads
 * that transcript mid-run: `scripts/work-runner.ts` builds its prompt from
 * `WorkSession.goal` and polls the event log only for an answer to the exact
 * question it is blocked on. So the honest report is that this was recorded,
 * and a surface that rendered "sent to Juno" over it would be describing a
 * delivery that did not happen.
 */
const STEER_EXPLANATION =
  "Kept on this task’s record. The attempt that is running was handed its instructions when " +
  "it started and does not re-read them, so this does not redirect what it is doing now.";

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
    select: { id: true, status: true },
  });

  return submission.kind === "answer"
    ? recordAnswer({ submission, sessionId: session.id, userId: user.id, run })
    : recordInstruction({ submission, userId: user.id, run });
}

interface Target<T> {
  submission: T;
  userId: string;
  run: { id: string; status: string } | null;
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
 * Records an instruction the run did not ask for.
 *
 * The event is written as `question_answered` with no `questionId` and a
 * `steering` marker, because `WORK_EVENT_KINDS` has no user-message kind and
 * that vocabulary is shared with the Mac and the phone — a route is not the
 * place to invent a kind those clients would render as a blank row. The marker
 * is what lets a reader tell the two apart, and `pollAnswer` in the runner
 * already ignores this row on its own terms: it requires `payload.questionId`
 * to equal the question it is blocked on, and there is none here.
 *
 * A run that IS waiting on a question is refused rather than accommodated, and
 * that refusal is the mechanism as much as the manners. `pollAnswer` reads the
 * NEWEST `question_answered` on the run; an instruction recorded while a
 * question was open would become that newest row and mask the answer underneath
 * it, and the run would sit out its wait as though nobody had replied. Refusing
 * here means the masking case cannot be constructed.
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
          "Juno is waiting for an answer to the question it asked. Answer that instead — an " +
          "instruction recorded now would sit on top of the answer and the run would keep waiting.",
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
        kind: "question_answered",
        payload: { text, answeredVia: "web", steering: true },
        ...(idempotencyKey === undefined ? {} : { key: `steer:${idempotencyKey}` }),
      },
    ],
  });

  // Attention is deliberately not touched. Nothing was demanded of the user, so
  // nothing about their having spoken says the run has stopped needing them —
  // and clearing the flag here would take a task off the "Needs you" list on the
  // strength of a sentence that answered nothing.
  return NextResponse.json({
    lastSeq: appended.lastSeq,
    replay: appended.duplicates > 0,
    delivered: false,
    explanation: STEER_EXPLANATION,
  });
}

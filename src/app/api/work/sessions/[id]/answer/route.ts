import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { appendEvents, setSessionAttention } from "@/lib/work/store";
import { answerSchema } from "@/app/api/work/protocol";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const parsed = answerSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { questionId, text, idempotencyKey } = parsed.data;

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
    userId: user.id,
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
    sessionId: session.id,
    userId: user.id,
    status: "waiting_input",
    needsAttention: false,
  });

  return NextResponse.json({
    lastSeq: appended.lastSeq,
    replay: appended.duplicates > 0,
  });
}

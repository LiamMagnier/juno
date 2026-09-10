import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { encryptMessageText } from "@/lib/message-crypto";
import { serializeMessage } from "@/lib/serializers";
import {
  appendTaskEvents,
  isTerminalTaskStatus,
  requireTaskAuth,
  type TaskEventInput,
} from "@/lib/code-remote";

export const runtime = "nodejs";

/*
 * SEND A NEW INSTRUCTION TO A TASK THAT IS ALREADY RUNNING.
 *
 * The composer used to go dark the moment a run started: `send` refused unless
 * the session was idle, the field was disabled, and the only verb left was
 * Stop. So a reader who saw the agent head down the wrong path had to kill the
 * run and start over, losing everything it had done so far.
 *
 * Modelled on ../rollback/route.ts, because it uses the same and only
 * mechanism a running task has for inbound control: an event appended to the
 * task's own stream and handed to the host on its next events POST (see
 * CONTROL_KINDS in src/lib/code-task-events.ts). The host injects the text as
 * the next user message of its live session and answers with `steer_ack`.
 * Nothing here reaches the machine directly.
 *
 * AUTHORISATION IS `requireTaskAuth` VERBATIM, with no widening.
 */

const schema = z.object({
  text: z.string().trim().min(1).max(20_000),
  /** Client-minted, and the idempotency key for the appended event. A retried
   *  POST that lost its response must not queue the instruction twice. */
  requestId: z.string().min(1).max(200),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, error } = await requireTaskAuth(id, req);
  if (!user) return error;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { text, requestId } = parsed.data;

  const task = await prisma.codeTask.findFirst({
    where: { id, userId: user.id },
    select: { id: true, status: true, target: true, conversationId: true },
  });
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // A finished task has no host to read the instruction. Refuse rather than
  // write a row nothing will ever consume — the same argument rollback makes.
  if (isTerminalTaskStatus(task.status)) {
    return NextResponse.json(
      { error: "task_finished", message: "This run has finished. Send the instruction as a new message instead." },
      { status: 409 },
    );
  }

  /*
   * CLOUD RUNS CANNOT BE STEERED YET, AND THIS SAYS SO.
   *
   * The cloud driver calls `AgentSession.prompt()` exactly once and reads its
   * control events only between event flushes; there is no point inside that
   * one turn at which a second user message could be injected. Accepting the
   * instruction would queue it forever behind a run that will never read it.
   * The refusal is the honest answer until the driver grows a between-step
   * message queue — scoped separately.
   */
  if (task.target === "cloud") {
    return NextResponse.json(
      {
        error: "steer_unsupported",
        message: "Cloud runs can’t take a new instruction mid-run yet. Wait for it to finish, then send a follow-up.",
      },
      { status: 409 },
    );
  }

  /*
   * THE INSTRUCTION IS A TURN OF THE READER'S, AND IT IS PERSISTED AS ONE.
   *
   * The task's outcome is folded into a single ASSISTANT row when it settles,
   * so an instruction that lived only in the event log would vanish from the
   * transcript on reload — the reader would see a run that changed direction
   * for no visible reason. Written before the control is appended, and only
   * for a linked conversation; a native-only task has no transcript here.
   */
  let userMessage = null;
  if (task.conversationId) {
    const created = await prisma.$transaction(async (tx) => {
      // Idempotent on `requestId`: a retried POST that lost its response finds
      // the row it already wrote via the event key below, so the row is
      // created only when the event has not been seen.
      const seen = await tx.codeTaskEvent.findFirst({
        where: { taskId: task.id, eventKey: `steer:${requestId}` },
        select: { id: true },
      });
      if (seen) return null;
      const message = await tx.message.create({
        data: { conversationId: task.conversationId!, role: "USER", content: encryptMessageText(text) },
      });
      await tx.conversation.updateMany({
        where: { id: task.conversationId!, userId: user.id },
        data: { lastMessageAt: new Date() },
      });
      return tx.message.findUniqueOrThrow({
        where: { id: message.id },
        include: { attachments: { where: { deletedAt: null } } },
      });
    });
    if (created) userMessage = await serializeMessage(created);
  }

  const events: TaskEventInput[] = [{ kind: "steer", payload: { requestId, text }, key: `steer:${requestId}` }];
  const { lastSeq } = await appendTaskEvents(task.id, events);
  // `queued`, never `delivered`. The far side has not read it yet — it will,
  // on its next post — and the outcome arrives as a `steer_ack` event.
  return NextResponse.json({ status: "queued", requestId, lastSeq, ...(userMessage ? { userMessage } : {}) });
}

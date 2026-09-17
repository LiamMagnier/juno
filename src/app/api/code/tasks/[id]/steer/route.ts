import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { encryptMessageText } from "@/lib/message-crypto";
import { serializeMessage } from "@/lib/serializers";
import { foldAttachmentsIntoPrompt } from "@/lib/code-attachment-prompt";
import { MAX_ATTACHMENTS } from "@/lib/uploads";
import {
  appendTaskEvents,
  isTerminalTaskStatus,
  requireTaskAuth,
  type TaskEventInput,
} from "@/lib/code-remote";

export const runtime = "nodejs";

/*
 * SEND A NEW INSTRUCTION TO A TASK THAT IS ALREADY RUNNING — OR STILL STARTING.
 *
 * The composer used to go dark the moment a run started: `send` refused unless
 * the session was idle, the field was disabled, and the only verb left was
 * Stop. So a reader who saw the agent head down the wrong path had to kill the
 * run and start over, losing everything it had done so far.
 *
 * Modelled on ../rollback/route.ts, because it uses the same and only
 * mechanism a running task has for inbound control: an event appended to the
 * task's own stream and handed to the host on its next events POST (see
 * CONTROL_KINDS in src/lib/code-task-events.ts). A host that honours the verb
 * injects the text as the next user message of its live session and answers
 * with `steer_ack`. Nothing here reaches the machine directly, and nothing here
 * can make a host act — today only the cloud driver does.
 *
 * AUTHORISATION IS `requireTaskAuth`, WITH NO WIDENING — and one narrowing:
 * attachments are refused from a task-token caller (see the POST).
 */

const schema = z
  .object({
    /*
     * Empty is allowed when something is attached, exactly as the create route
     * allows it: a screenshot dropped into a running session with the words
     * "this" left unsaid is a real thing people do, and the `+` menu being live
     * while the field is empty has to mean the circle can be pressed. The refine
     * below is what keeps an entirely empty steer out.
     */
    text: z.string().trim().max(20_000),
    /** Client-minted, and the idempotency key for the appended event. A retried
     *  POST that lost its response must not queue the instruction twice. */
    requestId: z.string().min(1).max(200),
    /**
     * Pre-uploaded attachments that ride along with the instruction, claimed
     * exactly as the create route claims them.
     *
     * The `+` menu used to rest while a run was going, because "an attachment
     * cannot ride a steer" — which was true of the transport only in the sense
     * that nothing had folded one in yet. A steer reaches its host as text, and
     * a task's first prompt reaches it as text too: the create route folds the
     * extracted text of every attachment into that string. The same fold is what
     * this does, so a screenshot dropped mid-run is as readable to the agent as
     * one dropped before it started.
     */
    attachmentIds: z.array(z.string().cuid()).max(MAX_ATTACHMENTS).optional(),
  })
  .refine((v) => v.text.length > 0 || (v.attachmentIds?.length ?? 0) > 0, {
    message: "text_or_attachments_required",
    path: ["text"],
  });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, viaTaskToken, error } = await requireTaskAuth(id, req);
  if (!user) return error;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { text, requestId } = parsed.data;
  /*
   * ATTACHMENTS ARE FOR THE READER'S OWN SESSION, NEVER FOR A TASK TOKEN.
   *
   * `requireTaskAuth` also accepts the cloud runner's `cct_` bearer, which the
   * events route calls out as untrusted — it lives on a machine the user does
   * not control. Claiming `attachmentIds` links rows the owner uploaded but has
   * not yet sent to a conversation, so a leaked task token could attach the
   * owner's unclaimed files to the conversation behind its own task. The scope
   * is narrow (their own `messageId: null` rows) but it is reach that token
   * never needed: nothing on a runner uploads a file. So the field is refused
   * rather than ignored, because a silently dropped attachment is the kind of
   * failure a caller repeats.
   */
  const attachmentIds = [...new Set(parsed.data.attachmentIds ?? [])];
  if (viaTaskToken && attachmentIds.length > 0) {
    return NextResponse.json(
      { error: "attachments_require_session", message: "Attachments can only be sent from a signed-in session." },
      { status: 403 },
    );
  }

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
   * A QUEUED TASK TAKES AN INSTRUCTION TOO, AND THAT IS A CHANGE.
   *
   * This route used to refuse a cloud task that was not yet `running` with
   * 409 `task_not_started`, on the grounds that there was no process to read
   * the control. The reasoning was right about the mechanism and wrong about
   * the window: starting a cloud machine takes a minute or more, and that is
   * exactly when a person notices they left out a constraint — and the only
   * thing they could do about it was cancel the run and start again.
   *
   * What closed it is that the runner reads its OWN backlog now. The
   * single-use runner-context handoff returns every unconsumed `steer` control
   * alongside `history`, and the driver folds them into the first prompt before
   * it calls the agent (scripts/cloud-code-runner.mjs), acking each one so the
   * composer's lifecycle still moves on the host's word rather than on ours.
   * A DEVICE TASK IS A DIFFERENT MATTER, AND THIS ROUTE IS NOT WHERE IT IS
   * SETTLED. Its host is handed the same control list on its first events POST
   * after claiming — that is how `cancel_request` reaches a queued run — but
   * delivery of the list is not handling of an entry. DesktopCodeHost.apply
   * switches on `approval_response` and `cancel_request` and drops the rest into
   * `default: break`, so a `steer` sent to a Mac is appended, never read and
   * never acked. Rather than refuse it here (a 409 the web would have to explain
   * after the fact), the verb is simply not offered for a device run: see
   * `canSteerRun` in src/lib/code-steer-policy.ts, which both the composer and
   * the hook's own guard read. A native client that starts honouring the control
   * needs no change on this side.
   *
   * So the only refusal left is the terminal one above. `queued` is accepted,
   * and the composer says "reads this before it starts" rather than lying about
   * a run that has not begun.
   */

  /*
   * THE INSTRUCTION IS A TURN OF THE READER'S, AND IT IS PERSISTED AS ONE.
   *
   * The task's outcome is folded into a single ASSISTANT row when it settles,
   * so an instruction that lived only in the event log would vanish from the
   * transcript on reload — the reader would see a run that changed direction
   * for no visible reason. Written before the control is appended, and only
   * for a linked conversation; a native-only task has no transcript here.
   *
   * The row carries what the person TYPED. The control below carries that text
   * with the attachments folded in — the same asymmetry the create route keeps
   * between `Message.content` and `CodeTask.prompt`, and for the same reason:
   * nobody wants to read a hundred kilobytes of extracted PDF in their own
   * transcript bubble.
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
      if (attachmentIds.length > 0) {
        // Unclaimed rows only, so a retry or a second message cannot steal an
        // attachment that already belongs to a turn. An id that loses the race
        // simply stays unlinked — the agent already has its text below.
        await tx.attachment.updateMany({
          where: { id: { in: attachmentIds }, userId: user.id, messageId: null, deletedAt: null },
          data: { messageId: message.id, conversationId: task.conversationId! },
        });
      }
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

  // What the agent actually reads. Looked up after the claim above so a file
  // that was deleted between upload and send contributes nothing rather than a
  // dangling filename.
  let agentText = text;
  /*
   * What a TRANSCRIPT shows for this instruction, which is not what the agent
   * reads.
   *
   * The web hook renders the persisted Message row and ignores the `user` event
   * the runner echoes back, but the native clients decode that event and draw it
   * (NativeCodeEvent.Kind.user). Sending the folded string as the event text put
   * up to 100 000 characters of extracted PDF per attachment into an iOS or Mac
   * reader's own bubble — the exact thing the asymmetry above exists to prevent,
   * arriving by the other door. So the control carries both: `text` for the
   * agent, `displayText` for anything that renders it.
   */
  let displayText = text;
  if (attachmentIds.length > 0) {
    const rows = await prisma.attachment.findMany({
      where: { id: { in: attachmentIds }, userId: user.id, deletedAt: null },
      select: { fileName: true, kind: true, mimeType: true, extractedText: true },
    });
    agentText = foldAttachmentsIntoPrompt(text, rows);
    // An attachment-only instruction has no sentence of its own, so it is named
    // by what it is rather than drawn as an empty bubble.
    const names = rows.map((row) => row.fileName).filter(Boolean);
    if (!text && names.length > 0) displayText = `Sent ${names.join(", ")}`;
  }
  /*
   * A control with no text is a control a host cannot act on. It can only
   * happen when every attachment named was gone by the time the fold ran, which
   * is a race with a delete — and the honest answer is that there is nothing to
   * send, not a `steer` event carrying an empty string.
   */
  if (!agentText.trim()) {
    return NextResponse.json(
      { error: "nothing_to_send", message: "There was nothing left to send — the attached files are no longer available." },
      { status: 409 },
    );
  }

  const events: TaskEventInput[] = [
    {
      kind: "steer",
      // `displayText` only when it differs, so an instruction with nothing
      // attached is the one string it has always been on the wire.
      payload: { requestId, text: agentText, ...(displayText === agentText ? {} : { displayText }) },
      key: `steer:${requestId}`,
    },
  ];
  const { lastSeq } = await appendTaskEvents(task.id, events);
  // `queued`, never `delivered`. The far side has not read it yet — it will,
  // on its next post, or out of runner-context when it starts — and the outcome
  // arrives as a `steer_ack` event.
  return NextResponse.json({ status: "queued", requestId, lastSeq, ...(userMessage ? { userMessage } : {}) });
}

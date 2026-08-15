import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  appendTaskEvents,
  isTerminalTaskStatus,
  requireTaskAuth,
  ROLLBACK_VERBS,
  ROLLBACK_VERBS_NEEDING_PATH,
  type RollbackVerb,
  type TaskEventInput,
} from "@/lib/code-remote";

export const runtime = "nodejs";

/*
 * ASK THE EXECUTING HOST TO ROLL SOMETHING BACK.
 *
 * Modelled line for line on ../cancel/route.ts, because it uses the same and
 * only mechanism a running task has for inbound control: an event appended to
 * the task's own stream, handed back to the host on its next events POST (see
 * CONTROL_KINDS in src/lib/code-task-events.ts). Nothing here reaches the
 * machine directly — this mutates a real repository on someone's computer, and
 * it does so only by asking the process that already holds that workspace.
 *
 * AUTHORISATION IS `requireTaskAuth` VERBATIM, with no widening. That means a
 * browser session or native bearer for the task's owner, or the task's own
 * `cct_` bearer — and the ownership-scoped lookup below is what actually
 * enforces it, exactly as the cancel and respond routes do. A rollback is a
 * destructive filesystem operation, so this is the last route in the tree that
 * should invent its own auth story.
 */

const schema = z.object({
  verb: z.enum(ROLLBACK_VERBS),
  /*
   * Workspace-relative, as every surface already spells file paths (the
   * `file_change` event, the changed-files list, the diff header). The host
   * resolves it against its own workspace root and refuses anything that
   * escapes — see AgentSession.revertFile. Absolute paths are rejected HERE as
   * well, rather than left for the host: a path that could name /etc/hosts has
   * no legitimate reading, and letting it travel means trusting every host
   * version in the field to be the one that checks.
   */
  path: z.string().min(1).max(1024).optional(),
  /** Client-minted, and the idempotency key for the appended event. A retried
   *  POST that lost its response must not enqueue a second revert — the first
   *  one may already have run, and reverting twice would take back a file the
   *  reader edited between the two. */
  requestId: z.string().min(1).max(200),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, error } = await requireTaskAuth(id, req);
  if (!user) return error;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { verb, requestId } = parsed.data;
  const path = parsed.data.path ?? null;

  if (ROLLBACK_VERBS_NEEDING_PATH.includes(verb) && !path) {
    return NextResponse.json({ error: "This action needs a file path." }, { status: 400 });
  }
  if (path && (path.startsWith("/") || path.includes("..") || /^[A-Za-z]:[\\/]/.test(path))) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const task = await prisma.codeTask.findFirst({ where: { id, userId: user.id }, select: { id: true, status: true } });
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  /*
   * A FINISHED TASK CANNOT BE ROLLED BACK, and this refuses instead of pretending.
   *
   * Stricter than the cancel route's guard, which only refuses the untrusted
   * runner — deliberately, and not as a security tightening. Control events are
   * delivered on the host's NEXT events POST, and a terminal task's host has
   * exited: the row would be written, nothing would ever read it, and no
   * `rollback_result` would come back. Accepting it would leave a control
   * spinning forever over a workspace nobody is holding. Refusing gives the
   * caller something true to say.
   */
  if (isTerminalTaskStatus(task.status)) {
    return NextResponse.json(
      { error: "task_finished", message: "This run has finished, so its host can no longer roll anything back." },
      { status: 409 },
    );
  }

  const payload: Record<string, string> = { requestId, ...(path ? { path } : {}) };
  const events: TaskEventInput[] = [{ kind: verb satisfies RollbackVerb, payload, key: `rollback:${requestId}` }];

  const { lastSeq } = await appendTaskEvents(task.id, events);
  // `requested`, never `applied`. The far side has not been asked yet — it will
  // be, on its next post — so the only honest thing to return is that the ask
  // is now on the stream. The outcome arrives as a `rollback_result` event.
  return NextResponse.json({ status: "requested", requestId, lastSeq });
}

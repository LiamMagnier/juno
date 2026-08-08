import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { Prisma, type WorkSession } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { serializeSession } from "@/lib/work/serializers";
import {
  createWorkSession,
  reconcileSessionAttachments,
  type SessionAttachmentGrant,
} from "@/lib/work/store";
import { isWorkModelAllowed } from "@/lib/work/models";
import { DEFAULT_WORK_PERMISSION_POLICY } from "@/lib/work/domain";
import { getUserPlan } from "@/lib/usage";
import { createSessionSchema, parseSessionListQuery } from "@/app/api/work/protocol";

export const runtime = "nodejs";

/**
 * The primary key a retried create lands on.
 *
 * `WorkSession` has no `(userId, idempotencyKey)` index — the column does not
 * exist on the model — so the primary key is the only uniqueness constraint a
 * session has, and deriving it from the caller's key is what turns "create this
 * session" into "create this session once". Both inputs are hashed together, so
 * two accounts using the same key cannot collide, and a key cannot be used to
 * guess or occupy another account's session id.
 *
 * `createWorkSession` takes this as its optional `id`, so the columns a session
 * starts life with are still written in exactly one place. Without idempotency
 * the normal outcome on mobile is a second session for every retried tap on a
 * flaky connection, not an exotic one.
 */
function idempotentSessionId(userId: string, key: string): string {
  return `wsi_${createHash("sha256").update(`${userId}\n${key}`, "utf8").digest("hex").slice(0, 32)}`;
}

/**
 * Writes the connected apps a task may reach.
 *
 * A route-local reconcile rather than an argument to `createWorkSession`,
 * matching how the attachment grants already reach a replayed session: the
 * whole set the client last sent replaces whatever is there, so a second press
 * with a switch turned back off removes the grant instead of leaving it. The
 * unique index on (sessionId, connectorId) means a repeated create is the same
 * grant arriving twice rather than two rows.
 *
 * `connectorsChosen` is set in the same transaction as the rows, because the two
 * are one fact. The flag alone says a reader answered; the rows alone say what
 * they answered; a session carrying one without the other is read by
 * src/lib/work/connectors.ts as a task that may reach everything the account
 * can, which is the one outcome a reader who switched everything off did not
 * ask for.
 */
async function writeSessionConnectors(
  // The signed-in user rather than their id, so every clause below reads
  // `userId: user.id`. That is the shape tests/work-security.test.ts follows
  // through the route tree, and a helper that took a bare string would put these
  // three writes outside the only check that proves a Work route cannot be made
  // to touch another account's rows.
  user: { id: string },
  sessionId: string,
  connectorIds: readonly string[]
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Written as a conditional rather than leaning on what an empty `notIn`
    // means: an empty selection is the common case here — it is what the
    // composer sends when the reader leaves every switch off — and "delete the
    // ones that are not in this empty list" is exactly the sort of clause that
    // is read as a no-op by whoever changes it next.
    await tx.workSessionConnector.deleteMany({
      where: {
        sessionId,
        userId: user.id,
        ...(connectorIds.length > 0 ? { connectorId: { notIn: [...connectorIds] } } : {}),
      },
    });
    if (connectorIds.length > 0) {
      await tx.workSessionConnector.createMany({
        data: connectorIds.map((connectorId) => ({ sessionId, userId: user.id, connectorId })),
        skipDuplicates: true,
      });
    }
    await tx.workSession.updateMany({
      where: { id: sessionId, userId: user.id },
      data: { connectorsChosen: true },
    });
  });
}

/**
 * Answers a create that landed on a session which already exists, after
 * bringing its file grants back in line with what this request carried.
 *
 * A replay used to skip granting altogether, on the reasoning that an
 * idempotency key promises the first request's outcome stands. It does, for the
 * session. It does not for the files, because the composer reuses a draft
 * whenever the goal is unchanged: the second press of a task whose attachment
 * the reader has since removed lands here, and until now the removed file
 * stayed granted, was copied onto the run's input manifest at dispatch, and was
 * read out to the model. The reader had deleted it from the UI and had no way
 * to find out otherwise.
 *
 * A failed reconcile cannot be answered with 200 and `replay: true`. That is
 * the composer being told the task is saved with the file list it is showing,
 * while the list in the database is the previous one — the same silent loss
 * from the other direction. 503 rather than 500: the session is intact, the
 * next press carries the same key and lands here again, and the reconcile is
 * the only thing that has to succeed.
 */
async function replaySession(
  session: WorkSession,
  user: { id: string },
  attachments: readonly SessionAttachmentGrant[] | null,
  connectorIds: readonly string[] | null
): Promise<NextResponse> {
  if (attachments) {
    try {
      await reconcileSessionAttachments({ userId: user.id, sessionId: session.id, attachments });
    } catch (err) {
      console.error("[work] could not reconcile the session's attachments", {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json(
        {
          error: "attachments_not_saved",
          message:
            "The task is saved but its file list is not, so nothing was started. Try again.",
        },
        { status: 503 }
      );
    }
  }
  // The same treatment, for the same reason and with the same failure. A reader
  // who turned an app off between two presses is making a narrowing that has to
  // land; answering 200 while the previous press's grant stands would be the
  // composer being told a permission was withdrawn that was not.
  if (connectorIds) {
    try {
      await writeSessionConnectors(user, session.id, connectorIds);
    } catch (err) {
      console.error("[work] could not save the session's connectors", {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json(
        {
          error: "connectors_not_saved",
          message:
            "The task is saved but the apps it may use are not, so nothing was started. Try again.",
        },
        { status: 503 }
      );
    }
  }
  return NextResponse.json({ session: serializeSession(session), replay: true }, { status: 200 });
}

export async function GET(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const parsed = parseSessionListQuery(new URL(req.url).searchParams);
  if (!parsed.ok) {
    return NextResponse.json({ error: "Invalid input", parameter: parsed.parameter }, { status: 400 });
  }
  const { status, needsAttention, pinned, archived, projectId, limit } = parsed.query;

  const sessions = await prisma.workSession.findMany({
    where: {
      userId: user.id,
      // Soft-deleted sessions are never listed. The row survives so an audit
      // question about what ran can still be answered; the user asked for it to
      // be gone from their list, and that is what the list must honour.
      deletedAt: null,
      archived,
      ...(status ? { status } : {}),
      ...(needsAttention !== undefined ? { needsAttention } : {}),
      ...(pinned !== undefined ? { pinned } : {}),
      ...(projectId ? { projectId } : {}),
    },
    // Pinned first so a session the user pinned does not fall off the end of a
    // clamped page, then most recently active — which is the order the indexes
    // on (userId, lastActivityAt) are built for.
    orderBy: [{ pinned: "desc" }, { lastActivityAt: "desc" }],
    take: limit,
  });

  return NextResponse.json({ sessions: sessions.map(serializeSession) });
}

export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const parsed = createSessionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const {
    goal,
    title,
    requestedTarget,
    preferredHostId,
    projectId,
    model,
    reasoningEffort,
    permissionPolicy,
    attachmentIds,
    connectorIds,
    idempotencyKey,
  } = parsed.data;

  // The plan gate, server-side. `createSessionSchema` deliberately does not
  // check the model against the catalog — the comment there explains why, and
  // it is a good reason — but "unvalidated against the catalog" was never meant
  // to mean "unvalidated against what this account has paid for". Until this
  // existed, a direct POST could name any model in the catalog and the lock in
  // the picker was the only thing in the way, which is to say nothing at all.
  //
  // Read only when a model was actually named. `isWorkModelAllowed` answers
  // true for an absent id, so the plan lookup would be a query asked in order
  // to be ignored.
  if (model) {
    const plan = await getUserPlan(user.id);
    if (!isWorkModelAllowed(model, plan)) {
      return NextResponse.json(
        {
          error: "plan_locked",
          message: "Your plan does not include that model, so nothing was created. Pick another one, or upgrade.",
        },
        { status: 403 }
      );
    }
  }

  // Cross-entity ownership is re-checked here rather than trusted from the
  // body: a host id or a project id in a request is a claim, and the only thing
  // that makes it true is a row that also carries this user's id.
  if (preferredHostId) {
    const host = await prisma.workHost.findFirst({
      where: { id: preferredHostId, userId: user.id },
      select: { id: true },
    });
    if (!host) return NextResponse.json({ error: "Host not found" }, { status: 404 });
  }
  if (projectId) {
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId: user.id },
      select: { id: true },
    });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Attachments get the same treatment, and it matters more here than for the
  // host or the project: a grant is the row that says the agent may read a
  // file, so an id accepted on trust would be a way to have Juno read somebody
  // else's upload out loud. Missing and not-yours are answered identically —
  // distinguishing them would turn this route into an oracle for which
  // attachment ids exist.
  //
  // Deduplicated first, and the grants are built in the order the reader sent
  // them rather than the order Postgres returned them, because that order is
  // the order the files are listed back to them and the order they are put in
  // front of the agent.
  //
  // Absent and empty are different requests, and null is how the difference is
  // carried past this block. An absent `attachmentIds` is a client with nothing
  // to say about files, and leaves whatever the session already holds alone; a
  // present `[]` is a client stating that the set is now empty, which is what a
  // reader who has removed their last file means. Reading them the same way
  // would make every caller that has never heard of attachments revoke the
  // grants of a session it is only trying to re-create.
  let attachments: SessionAttachmentGrant[] | null = null;
  if (attachmentIds) {
    attachments = [];
    const wanted = [...new Set(attachmentIds)];
    if (wanted.length > 0) {
      const rows = await prisma.attachment.findMany({
        where: { id: { in: wanted }, userId: user.id, deletedAt: null },
        select: { id: true, fileName: true },
      });
      if (rows.length !== wanted.length) {
        return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
      }
      const byId = new Map(rows.map((row) => [row.id, row.fileName]));
      for (const attachmentId of wanted) {
        attachments.push({ attachmentId, fileName: byId.get(attachmentId) ?? attachmentId });
      }
    }
  }

  // The connectors this task may reach get the ownership check the attachments
  // get, and it is the same argument: a provider id in a request body is a claim
  // that the account has linked that app, and the only thing that makes it true
  // is a `Connection` row carrying this user's id. A grant written on trust would
  // be a task holding a permission for an app nobody connected — harmless today,
  // because the executor resolves credentials and would find none, and precisely
  // the row that stops being harmless the day somebody links that app.
  //
  // Deduplicated first, and null when the client said nothing. Absent leaves the
  // session's own answer alone — see the schema note on `connectorsChosen` — and
  // a present `[]` is a reader who switched everything off, which is a real
  // answer and is written as one.
  let connectors: string[] | null = null;
  if (connectorIds) {
    connectors = [...new Set(connectorIds)];
    if (connectors.length > 0) {
      const linked = await prisma.connection.findMany({
        where: { userId: user.id, provider: { in: connectors } },
        select: { provider: true },
      });
      const have = new Set(linked.map((row) => row.provider));
      if (connectors.some((connectorId) => !have.has(connectorId))) {
        return NextResponse.json(
          {
            error: "connector_not_linked",
            message:
              "One of the apps this task was given is not connected to your account, so nothing was created.",
          },
          { status: 404 }
        );
      }
    }
  }

  const sessionId = idempotencyKey ? idempotentSessionId(user.id, idempotencyKey) : undefined;
  if (sessionId) {
    // Turns the common sequential retry into a clean replay instead of a 500
    // from the unique violation. The catch below is what handles the two
    // requests that raced past this read.
    const existing = await prisma.workSession.findFirst({ where: { id: sessionId, userId: user.id } });
    if (existing) return replaySession(existing, user, attachments, connectors);
  }

  try {
    const session = await createWorkSession({
      ...(sessionId ? { id: sessionId } : {}),
      userId: user.id,
      // The goal doubles as the name until the user or the planner picks a
      // better one; `titleSource` stays "default" so an auto-title may still
      // replace it, and a user rename sets it to "manual" and stops that.
      title: title ?? goal.slice(0, 60),
      goal,
      projectId: projectId ?? null,
      requestedTarget,
      preferredHostId: preferredHostId ?? null,
      requestedModel: model ?? null,
      reasoningEffort: reasoningEffort ?? null,
      // The approval mode this task was composed with. Absent means the client
      // has no control for it — the native composer, and every browser build
      // before the segmented control shipped — and those tasks get
      // `DEFAULT_WORK_PERMISSION_POLICY`, which is the value the column already
      // defaulted to. Nothing about an existing client's behaviour changes.
      //
      // Not checked against anything here, and it does not need to be: the
      // session's mode is a request, and `resolveApprovalMode` intersects it
      // with the Mac's advertised policy at dispatch. A session composed as Skip
      // that only ever lands on a Mac pinned to Manual runs Manual every time,
      // and the run says so.
      permissionPolicy: permissionPolicy ?? DEFAULT_WORK_PERMISSION_POLICY,
      // Written in the same transaction as the session rather than by a second
      // call after it, so a session never comes back as created while the files
      // the reader attached to it are missing. See `createWorkSession`.
      attachments: attachments ?? [],
    });

    // A second write rather than part of the create's transaction, because
    // `createWorkSession` does not take connectors and a store function that
    // grew a second grant type would be the wrong place to settle that. The
    // failure direction is what makes the split safe: a session whose connector
    // rows did not land is a session that reaches no connector at all, and the
    // 503 says so rather than reporting a task that was created with permissions
    // it does not hold. The idempotency key makes the next press land on this
    // same session and finish the job.
    if (connectors) {
      try {
        await writeSessionConnectors(user, session.id, connectors);
      } catch (err) {
        console.error("[work] could not save the session's connectors", {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return NextResponse.json(
          {
            error: "connectors_not_saved",
            message:
              "The task is saved but the apps it may use are not, so nothing was started. Try again.",
          },
          { status: 503 }
        );
      }
    }
    return NextResponse.json({ session: serializeSession(session) }, { status: 201 });
  } catch (err) {
    // Two identical creates raced past the pre-check above: the primary key
    // rejects the loser, which then reads the winner. From the caller's point
    // of view the session it asked for now exists, which is what it wanted. It
    // goes through the same replay path as the pre-check, so the loser confirms
    // the grants rather than assuming the winner's set matched its own — the
    // reconcile is a no-op when they agree, and the two requests only agree
    // because they share an idempotency key, which is a convention rather than
    // a constraint.
    if (
      sessionId &&
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const winner = await prisma.workSession.findFirst({ where: { id: sessionId, userId: user.id } });
      if (winner) return replaySession(winner, user, attachments, connectors);
    }
    throw err;
  }
}

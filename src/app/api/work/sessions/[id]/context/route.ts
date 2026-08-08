import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { isOwnerEmail } from "@/lib/owner";
import { rateLimit } from "@/lib/rate-limit";
import { getUserPlan } from "@/lib/usage";
import { isWorkModelAllowed } from "@/lib/work/models";
import {
  WORK_LEASED_STATUSES,
  reconcileSessionAttachments,
  reconcileSessionConnectors,
  type SessionAttachmentGrant,
} from "@/lib/work/store";
import { serializeSession } from "@/lib/work/serializers";
import {
  SKILL_NOT_EDITABLE,
  describeGrantChange,
  describeSettingChange,
  patchSessionContextSchema,
  type WorkContextFieldResult,
} from "@/app/api/work/protocol";

export const runtime = "nodejs";

/**
 * Editing what an existing task may reach.
 *
 * One route, one method, and one rule stated at the top because everything below
 * is an application of it: **a change made during a task takes effect on the
 * next attempt, except where it provably can apply sooner.** The exception is
 * narrowing. Removing a file or an app takes a permission away, nothing
 * downstream can refuse it, and it binds every attempt from the moment this
 * commits. Adding one is a new grant, and a grant has to pass the layers a
 * dispatch applies — the plan, the host, the project, the skill — which are only
 * ever all in the room at the start of an attempt.
 *
 * That asymmetry is not invented here. It is the same one `narrowHostToggles`
 * encodes for a Mac's capability switches, the same one `resolveApprovalMode`
 * encodes for approval policy, and the same one `resolveSkillPermissions`
 * encodes for skills: in this codebase permission only ever narrows on its way
 * down.
 *
 * The response says which of the two happened, per field, in words the control
 * can show. That is the point of the route as much as the writes are. The
 * failure mode worth building against is a save button that goes green while the
 * running attempt never sees the file — and `inFlightCaveat` on the result is
 * the field that stops the green tick from being a lie, because a run that has
 * already been handed a document's text or has already opened a connector's
 * socket keeps both until it finishes.
 *
 * `WorkSession.goal` is not editable here and never will be. It is what the user
 * asked for verbatim and what every plan is checked back against.
 */

/**
 * How many context saves a task's owner may make per minute.
 *
 * Higher than the ten-a-minute ceiling on run dispatch, because the costs are
 * not comparable: a run holds an executor for as long as the work takes, while
 * this is a handful of small writes. Bounded all the same — each save is a
 * transaction plus up to three ownership queries, and a composer with a
 * save-on-keystroke bug is a realistic way to find that out.
 */
const WORK_CONTEXT_RATE_LIMIT = 30;

/** The statuses in which an attempt has already read its files and opened its
 *  apps. A `queued` or `paused` run has read nothing yet, so it is not in
 *  flight for the purpose of the caveat on a narrowing. */
const IN_FLIGHT_STATUSES = new Set<string>(WORK_LEASED_STATUSES);

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const parsed = patchSessionContextSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const body = parsed.data;

  const session = await prisma.workSession.findFirst({
    where: { id, userId: user.id, deletedAt: null },
  });
  // Missing and not-yours are answered identically, the same way every other
  // Work route answers them. Distinguishing the two would turn this into an
  // oracle for which session ids exist.
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Before the ownership checks below rather than after them, unlike the run
  // dispatch route. That route puts its limit last so a deployment with no
  // provider configured does not cost the reader one of their ten runs a minute
  // — a refusal that is nobody's fault on this side. Nothing here is like that:
  // every refusal below is about the request, and each one costs a query, so a
  // client in a loop should be stopped before it spends three of them a time.
  if (!isOwnerEmail(user.email)) {
    const limited = await rateLimit({
      key: `work-context:${user.id}`,
      limit: WORK_CONTEXT_RATE_LIMIT,
      windowSec: 60,
    });
    if (!limited.success) {
      return NextResponse.json(
        { error: "Too many changes at once. Try again shortly." },
        { status: 429 }
      );
    }
  }

  // -------------------------------------------------------------------------
  // Everything that can be refused, before anything is written
  // -------------------------------------------------------------------------
  //
  // A save that half-lands is worse than one that does not land at all: the
  // reader sees a control settle and has no way to tell which half of their
  // edit is real. So every claim in the body is checked against a row that also
  // carries this user's id before the first write happens.

  if (body.projectId) {
    const project = await prisma.project.findFirst({
      where: { id: body.projectId, userId: user.id },
      select: { id: true },
    });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // The plan gate, on the id this task would next ask for. Same check and same
  // sentence as the create and dispatch routes: a model the account is not
  // entitled to must not become the session's stored choice, or the next
  // dispatch is a paid model started by an unpaid account without anybody
  // choosing that.
  if (body.model !== undefined) {
    const plan = await getUserPlan(user.id);
    if (!isWorkModelAllowed(body.model, plan)) {
      return NextResponse.json(
        {
          error: "plan_locked",
          message:
            "Your plan does not include that model, so nothing was changed. Pick another one, or upgrade.",
        },
        { status: 403 }
      );
    }
  }

  // Attachments, deduplicated and re-checked. An id in a request body is a claim
  // about ownership and the only thing that makes it true is an `Attachment` row
  // scoped to this account — an id accepted on trust would be a way to have Juno
  // read somebody else's upload out loud. The grants are built in the order the
  // reader sent them, because that is the order they are listed back and the
  // order they are put in front of the agent.
  let attachments: SessionAttachmentGrant[] | null = null;
  if (body.attachmentIds) {
    attachments = [];
    const wanted = [...new Set(body.attachmentIds)];
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

  // The same treatment for connected apps, and the same argument: a grant
  // written on trust would be a task holding a permission for an app nobody
  // connected — harmless while no credential resolves, and precisely the row
  // that stops being harmless the day somebody links that app.
  let connectors: string[] | null = null;
  if (body.connectorIds) {
    connectors = [...new Set(body.connectorIds)];
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
              "One of the apps you gave this task is not connected to your account, so nothing was changed.",
          },
          { status: 404 }
        );
      }
    }
  }

  // The attempt as it stands right now, read before the writes so the sentences
  // below describe the run the reader is actually looking at. Highest attempt
  // rather than most recently updated, for the reason `GET` on the session
  // states: a superseded run finishing after its replacement started would
  // otherwise be treated as the current one.
  const current = await prisma.workRun.findFirst({
    where: { sessionId: session.id, userId: user.id },
    orderBy: { attempt: "desc" },
    select: { id: true, attempt: true, status: true },
  });
  const runInFlight = current !== null && IN_FLIGHT_STATUSES.has(current.status);

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  const applied: WorkContextFieldResult[] = [];

  if (attachments) {
    try {
      const { granted, revoked } = await reconcileSessionAttachments({
        userId: user.id,
        sessionId: session.id,
        attachments,
      });
      applied.push(
        describeGrantChange({ field: "files", removed: revoked, added: granted, runInFlight })
      );
    } catch (err) {
      console.error("[work] could not change the session's files", {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
      // 503 rather than 500, and the message says nothing changed rather than
      // leaving it open. The session is intact and the whole set is in the next
      // request, so the honest instruction is "try again" — and the one thing
      // this must never do is answer 200 with a file list the database does not
      // hold, which is the silent loss the reconcile exists to prevent.
      return NextResponse.json(
        {
          error: "files_not_saved",
          message: "The files on this task could not be changed, so nothing was changed. Try again.",
        },
        { status: 503 }
      );
    }
  }

  if (connectors) {
    try {
      const { added, removed } = await reconcileSessionConnectors({
        userId: user.id,
        sessionId: session.id,
        connectorIds: connectors,
      });
      applied.push(
        describeGrantChange({
          field: "connectors",
          removed,
          added,
          runInFlight,
          // Read off the row loaded before the write. A task nobody had asked
          // could reach every app the account has linked, so answering at all
          // narrows it — see `firstAnswer`.
          firstAnswer: !session.connectorsChosen,
        })
      );
    } catch (err) {
      console.error("[work] could not change the session's connectors", {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json(
        {
          error: "connectors_not_saved",
          message: "The apps this task may use could not be changed, so nothing else was changed. Try again.",
        },
        { status: 503 }
      );
    }
  }

  // The four settings that bind at dispatch, compared against the row that was
  // read at the top so a replay reports `unchanged` rather than rewriting the
  // same value and calling it an edit.
  const settings: Prisma.WorkSessionUpdateInput = {};
  if (body.model !== undefined) {
    const changed = body.model !== session.requestedModel;
    if (changed) settings.requestedModel = body.model;
    applied.push(describeSettingChange({ field: "model", changed }));
  }
  if (body.reasoningEffort !== undefined) {
    const changed = body.reasoningEffort !== session.reasoningEffort;
    if (changed) settings.reasoningEffort = body.reasoningEffort;
    applied.push(describeSettingChange({ field: "reasoningEffort", changed }));
  }
  if (body.permissionPolicy !== undefined) {
    const changed = body.permissionPolicy !== session.permissionPolicy;
    if (changed) settings.permissionPolicy = body.permissionPolicy;
    applied.push(describeSettingChange({ field: "permissionPolicy", changed }));
  }
  if (body.projectId !== undefined) {
    const changed = body.projectId !== session.projectId;
    // Written through the relation rather than the scalar, which is what Prisma's
    // update input takes when a model has a relation on the column: `disconnect`
    // is how "unfiled" is expressed, and it is a real choice a reader makes.
    if (changed) {
      settings.project = body.projectId
        ? { connect: { id: body.projectId } }
        : { disconnect: true };
    }
    applied.push(describeSettingChange({ field: "project", changed }));
  }

  if (body.skillSlug !== undefined) applied.push(SKILL_NOT_EDITABLE);

  // `lastActivityAt` moves only when something actually moved. Bumping it on a
  // replay would push a task to the top of the list for a save that changed
  // nothing, and the list's order is the main thing a reader uses to find the
  // task they were just working on.
  const touched = applied.some((entry) => entry.change !== "unchanged" && entry.change !== "refused");
  const updated =
    Object.keys(settings).length > 0 || touched
      ? await prisma.workSession.update({
          where: { id: session.id, userId: user.id },
          data: { ...settings, ...(touched ? { lastActivityAt: new Date() } : {}) },
        })
      : session;

  return NextResponse.json({
    session: serializeSession(updated),
    applied,
    // The attempt these promises are about, so the control can name it — "the
    // attempt running now" is a phrase a reader can check, and a client left to
    // infer it from the session status would get it wrong for a run that
    // finished between the two reads.
    currentRun: current ? { id: current.id, attempt: current.attempt, inFlight: runInFlight } : null,
  });
}

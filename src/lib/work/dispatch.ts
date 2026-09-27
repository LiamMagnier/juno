import "server-only";

import { createHash } from "node:crypto";
import { Prisma, type Plan, type WorkHost, type WorkRun, type WorkSession } from "@prisma/client";
import type { z } from "zod";
import { prisma } from "@/lib/prisma";
import { isOwnerEmail } from "@/lib/owner";
import { rateLimit } from "@/lib/rate-limit";
import { MODEL_LIST, resolveModel } from "@/lib/models";
import { configuredProviders } from "@/lib/providers";
import { getUserPlan } from "@/lib/usage";
import { canUseModel } from "@/lib/plans";
import type { SessionUser } from "@/lib/session";
import { serializeRun, serializeSession } from "@/lib/work/serializers";
import {
  createRun,
  createWorkSession,
  reconcileSessionAttachments,
  recordRunInputsFromGrants,
  WorkSpendAdmissionError,
  type CreateRunResult,
  type RunDrivingCommand,
  type SessionAttachmentGrant,
} from "@/lib/work/store";
import {
  defaultWorkModelId,
  isAutoModelId,
  isWorkCapableModel,
  isWorkModelAllowed,
  pickWorkModel,
  workFailoverModels,
  workModelOptions,
} from "@/lib/work/models";
import {
  WORK_LIVE_STATUSES,
  WORK_PERMISSION_POLICIES,
  WORK_TARGETS,
  resolveApprovalMode,
  selectTarget,
  type HostCapabilityView,
  type WorkCapability,
  type WorkDegradation,
  type WorkPermissionPolicy,
  type WorkTarget,
} from "@/lib/work/domain";
import {
  inheritFromProjectDefaults,
  parseWorkDefaults,
  resolveSessionFields,
  type InheritedFromProject,
  type WorkProjectDefaults,
} from "@/lib/work/projects";
import { runBudgetForWindow } from "@/lib/work/budget";
import { checkUsageWindows } from "@/lib/spend";
import { windowLimitMessage } from "@/lib/spend-ceiling";
import { inferCapabilities, selectForInferred } from "@/lib/work/inference";
import { planRunCommand, refusalBody, startCommandPayload } from "@/lib/work/relay";
import { estimateWorkRunCost, type WorkCostEstimate } from "@/lib/work/preflight-cost";
import {
  effectiveHostState,
  refusalForSelection,
  type createSessionSchema,
  type startRunSchema,
} from "@/app/api/work/protocol";

/*
 * Creating a task and starting its run, for every caller that does either.
 *
 * These were the bodies of `POST /api/work/sessions` and
 * `POST /api/work/sessions/[id]/runs`, and they moved here when a second caller
 * appeared: the chat model's `start_task` tool (src/lib/chat/task-tool.ts),
 * which starts a task from inside a chat turn. That caller has to pass through
 * exactly the checks a person pressing the button does (the plan gate, the
 * ownership checks, the usage windows, the cost preflight, the rate limit, the
 * concurrency cap, the approval-mode narrowing), and a second copy of them in
 * the chat route would be two implementations that drift on precisely the
 * parts that are invisible until they are wrong. `fire-now.ts` is the same
 * move for the Run-now button and the trigger fire URL.
 *
 * Each function answers `{ status, body }` rather than a `Response`, and the
 * routes wrap that in `NextResponse.json` unchanged. The bodies are the routes'
 * wire contract, which the native clients decode (contracts/openapi), so every
 * body below is built exactly as the route used to build it, key order
 * included. The chat tool reads the same bodies, which is also why a refusal it
 * reports to the model is the route's own sentence rather than a paraphrase.
 *
 * Every query is scoped with `userId: user.id`, where `user` is the caller's
 * resolved session user and never something read from a request body.
 * tests/work-security.test.ts scans this file with the rules it applies to the
 * Work routes, for exactly that reason.
 */

/** The signed-in account a dispatch acts for: `requireUser`'s user, or the chat route's. */
export type WorkDispatchUser = Pick<SessionUser, "id" | "email">;

/** What a route writes back: the status and the JSON body, byte for byte. */
export interface WorkDispatchResponse {
  status: number;
  body: Record<string, unknown>;
}

export type CreateWorkSessionBody = z.infer<typeof createSessionSchema>;
export type StartWorkRunBody = z.infer<typeof startRunSchema>;

export interface CreateWorkSessionResponse extends WorkDispatchResponse {
  /** The session the body describes, created or replayed; null on a refusal. */
  session: WorkSession | null;
}

export interface StartWorkRunResponse extends WorkDispatchResponse {
  /** The run the body describes, created or replayed; null on a refusal. */
  run: WorkRun | null;
  /** The cost estimate, once the run's model was resolved far enough to make one. */
  preflight: WorkCostEstimate | null;
}

// ---------------------------------------------------------------------------
// Creating a session
// ---------------------------------------------------------------------------

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
 * The id a create with this idempotency key lands on, for a caller that has to
 * recognise its own session before creating it: the chat tool's live-task
 * guard, which must not refuse a retry of the very task it started.
 */
export function sessionIdForKey(user: WorkDispatchUser, key: string): string {
  return idempotentSessionId(user.id, key);
}

/**
 * Writes the connected apps a task may reach.
 *
 * A local reconcile rather than an argument to `createWorkSession`, matching
 * how the attachment grants already reach a replayed session: the whole set the
 * client last sent replaces whatever is there, so a second press with a switch
 * turned back off removes the grant instead of leaving it. The unique index on
 * (sessionId, connectorId) means a repeated create is the same grant arriving
 * twice rather than two rows.
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
  // through this file, and a helper that took a bare string would put these
  // three writes outside the only check that proves a Work dispatch cannot be
  // made to touch another account's rows.
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
): Promise<CreateWorkSessionResponse> {
  if (attachments) {
    try {
      await reconcileSessionAttachments({ userId: user.id, sessionId: session.id, attachments });
    } catch (err) {
      console.error("[work] could not reconcile the session's attachments", {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        status: 503,
        body: {
          error: "attachments_not_saved",
          message:
            "The task is saved but its file list is not, so nothing was started. Try again.",
        },
        session: null,
      };
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
      return {
        status: 503,
        body: {
          error: "connectors_not_saved",
          message:
            "The task is saved but the apps it may use are not, so nothing was started. Try again.",
        },
        session: null,
      };
    }
  }
  return { status: 200, body: { session: serializeSession(session), replay: true }, session };
}

/**
 * The project's half of the bundle, with the two claims in it checked.
 *
 * The narrowing itself is `inheritFromProjectDefaults`, which is pure and
 * tested as such — including the property that decides whether a project is a
 * folder or a consent surface: it may only ever narrow from
 * `DEFAULT_WORK_PERMISSION_POLICY`, never widen past it. The skills half of the
 * bundle is not here either: a skill filed in a project is already a
 * `WorkSkill` carrying its `projectId`, and `skillIsOfferedTo` is what the
 * executor reads.
 *
 * What is left for this function is the two fields that name a row. A Mac and a
 * model in a stored JSON blob are claims like any other id, and the only things
 * that make them true are a row carrying this user and a plan that includes the
 * model.
 *
 * Both are DROPPED rather than refused when they do not resolve. A project
 * naming a Mac that has since been unpaired, or a model this plan does not
 * include, must not make every task filed there impossible to create — the run
 * picks a model and a target on its own and records what it chose, which is a
 * working task with a degradation rather than a 403 on a setting the reader may
 * not even know is there.
 */
async function inheritFromProject(
  user: { id: string },
  requestedTarget: WorkTarget,
  defaults: WorkProjectDefaults
): Promise<InheritedFromProject> {
  // The account's linked apps, which are the ceiling the project's list is
  // intersected against: a project naming Gmail does not thereby link Gmail.
  // Read only when there is a list to intersect, so a project with no connector
  // opinion costs no query. User MCP servers (`user_mcp:<id>`) are linked
  // through their own table and join the same ceiling list.
  let linkedConnectorIds: string[] = [];
  if (defaults.connectorIds !== undefined) {
    const { userMcpConnectorId } = await import("@/lib/user-mcp");
    const connections = await prisma.connection.findMany({
      where: { userId: user.id },
      select: { provider: true },
    });
    const userServers = await prisma.userMcpServer.findMany({
      where: { userId: user.id, enabled: true },
      select: { id: true },
    });
    linkedConnectorIds = [
      ...connections.map((row) => row.provider),
      ...userServers.map((row) => userMcpConnectorId(row.id)),
    ];
  }

  const inherited = inheritFromProjectDefaults({
    requestedTarget,
    linkedConnectorIds,
    defaults,
  });

  const host = inherited.preferredHostId
    ? await prisma.workHost.findFirst({
        where: { id: inherited.preferredHostId, userId: user.id },
        select: { id: true },
      })
    : null;

  // The same plan gate the body's model goes through, on the project's. The two
  // are mutually exclusive — this branch is only reached when the client named
  // no model — so the plan is read at most once per request.
  const model =
    inherited.model && isWorkModelAllowed(inherited.model, await getUserPlan(user.id))
      ? inherited.model
      : null;

  return { ...inherited, model, preferredHostId: host?.id ?? null };
}

/**
 * Creates a task, or answers with the one this idempotency key already made.
 *
 * The body of `POST /api/work/sessions` after authentication and parsing. A
 * session is created as a draft: it costs nothing and holds no executor until
 * `startWorkRunForUser` dispatches it.
 */
export async function createWorkSessionForUser(
  user: WorkDispatchUser,
  input: CreateWorkSessionBody
): Promise<CreateWorkSessionResponse> {
  const {
    goal,
    title,
    requestedTarget,
    preferredHostId,
    projectId,
    conversationId,
    model,
    reasoningEffort,
    permissionPolicy,
    attachmentIds,
    connectorIds,
    idempotencyKey,
  } = input;

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
      return {
        status: 403,
        body: {
          error: "plan_locked",
          message: "Your plan does not include that model, so nothing was created. Pick another one, or upgrade.",
        },
        session: null,
      };
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
    if (!host) return { status: 404, body: { error: "Host not found" }, session: null };
  }
  let projectDefaults: WorkProjectDefaults = {};
  if (projectId) {
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId: user.id },
      select: { id: true, workDefaults: true },
    });
    if (!project) return { status: 404, body: { error: "Project not found" }, session: null };
    projectDefaults = parseWorkDefaults(project.workDefaults);
  }
  // The chat this task was delegated from, checked the same way and for a
  // sharper reason than the project: this pointer is what makes the run render
  // inside a transcript, so an id accepted on trust would put somebody's task —
  // its goal, its plan, its questions — into another account's conversation.
  if (conversationId) {
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, userId: user.id },
      select: { id: true },
    });
    if (!conversation) {
      return { status: 404, body: { error: "Conversation not found" }, session: null };
    }
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
        return { status: 404, body: { error: "Attachment not found" }, session: null };
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
        return {
          status: 404,
          body: {
            error: "connector_not_linked",
            message:
              "One of the apps this task was given is not connected to your account, so nothing was created.",
          },
          session: null,
        };
      }
    }
  }

  // What the project it was filed in supplies.
  //
  // The fold is pure and lives beside the resolver, because the rule it encodes
  // is not the same for every field: the scalars fall through to the project
  // only when the client was silent, while the approval mode and the connector
  // list MEET with the project's. See `resolveSessionFields` for why — in one
  // sentence, a client that always states a mode, which is every browser build
  // since the segmented control shipped, would otherwise make a project's
  // approval setting a control that visibly does nothing.
  const inherited = await inheritFromProject(user, requestedTarget, projectDefaults);
  const resolvedFields = resolveSessionFields(
    {
      model,
      reasoningEffort,
      permissionPolicy,
      // `null` here is this function's spelling of "the client said nothing",
      // which `resolveSessionFields` spells `undefined` because that is what an
      // absent optional field is everywhere else.
      connectorIds: connectors ?? undefined,
      preferredHostId,
    },
    inherited
  );
  // Tested against null rather than against emptiness, which is the same
  // distinction the block above draws: a present `[]` is a reader who switched
  // every app off, and reading it as "nothing said" would hand the task back the
  // apps they had just removed.
  const chosenConnectors = resolvedFields.connectorIds;

  const sessionId = idempotencyKey ? idempotentSessionId(user.id, idempotencyKey) : undefined;
  if (sessionId) {
    // Turns the common sequential retry into a clean replay instead of a 500
    // from the unique violation. The catch below is what handles the two
    // requests that raced past this read.
    const existing = await prisma.workSession.findFirst({ where: { id: sessionId, userId: user.id } });
    // A replay reconciles what THIS request carried, and a request that said
    // nothing about apps must leave whatever the task already holds alone —
    // otherwise a second press of the composer would overwrite a change the
    // reader made to the task in between. So the DEFAULT half of the fold is
    // deliberately skipped here and only the CEILING half is applied: a client
    // that sent a list gets it intersected with the project's, and a client
    // that sent none gets nothing written. Without that intersection the
    // project's connector ceiling would be escapable by pressing send twice,
    // which is the whole invariant undone by a retry.
    if (existing) {
      return replaySession(existing, user, attachments, connectors === null ? null : chosenConnectors);
    }
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
      // Absent stays null, which is what a standalone task has always been.
      conversationId: conversationId ?? null,
      requestedTarget,
      // The three scalars fall through to the project's answer only when the
      // client gave none, which is `resolveSessionFields`' `??` rule: absent
      // means "no opinion", unlike the connector list above.
      preferredHostId: resolvedFields.preferredHostId,
      requestedModel: resolvedFields.model,
      reasoningEffort: resolvedFields.reasoningEffort,
      // The approval mode this task was composed with, after meeting the
      // project's. A client that sends none — the native composer, and every
      // browser build before the segmented control shipped — gets
      // `DEFAULT_WORK_PERMISSION_POLICY` or whatever narrower mode the project
      // states, which is at most the value the column already defaulted to.
      //
      // This is a request rather than a verdict, and it does not need checking
      // here: `resolveApprovalMode` intersects it with the Mac's advertised
      // policy at dispatch. A session composed as Skip that only ever lands on
      // a Mac pinned to Manual runs Manual every time, and the run says so.
      permissionPolicy: resolvedFields.permissionPolicy,
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
    if (chosenConnectors) {
      try {
        await writeSessionConnectors(user, session.id, chosenConnectors);
      } catch (err) {
        console.error("[work] could not save the session's connectors", {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          status: 503,
          body: {
            error: "connectors_not_saved",
            message:
              "The task is saved but the apps it may use are not, so nothing was started. Try again.",
          },
          session: null,
        };
      }
    }
    return { status: 201, body: { session: serializeSession(session) }, session };
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
      // The same narrowed list the pre-check replay uses, and for the same
      // reason: the project's connector ceiling has to hold on every path that
      // writes grants, not only on the one that creates the session.
      if (winner) {
        return replaySession(winner, user, attachments, connectors === null ? null : chosenConnectors);
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Starting a run
// ---------------------------------------------------------------------------

// Abuse controls for run dispatch. A run holds an executor — a cloud container
// or a Mac the user is sitting at — for as long as the work takes, so the cost
// of an unbounded client is not a wasted request, it is a fleet.
/** Max runs a user may start per minute. */
const WORK_RUN_RATE_LIMIT = 10;
/** Max simultaneously live runs per user, across every session. */
const WORK_RUN_CONCURRENCY_CAP = 3;
/**
 * How many previous failures a retry looks back over when choosing a model.
 *
 * Bounded so a task retried thirty times does not send a thirty-item `NOT IN`
 * to the router, and so a model that failed once a month ago is eligible again
 * — the pool is not large, and permanently retiring a model from a task on one
 * bad afternoon would eventually leave nothing to run it on.
 */
const MAX_FAILOVER_HISTORY = 4;

/**
 * Whether cloud Work is accepting runs.
 *
 * A constant because there is one cloud executor and no kill switch in front of
 * it today. It is named and passed to `selectTarget` rather than assumed at the
 * call site so that turning cloud off — a paused executor, a provider outage —
 * is one edit here that produces the honest refusal `selectTarget` already
 * writes, instead of a queue of runs that nothing will ever claim.
 */
const CLOUD_WORK_AVAILABLE = true;

/*
 * What bounds a run is `runBudgetForWindow` in src/lib/work/budget.ts, fed by
 * `checkUsageWindows` — the account's rolling 5-hour and weekly windows and
 * nothing else. There is no per-run ceiling any more; the argument for removing
 * the plan-shaped table that used to live behind this comment is on that
 * module, and the composer's disclosure reads its sentence from the same place
 * rather than keeping a copy of any number.
 */

/**
 * What a host can currently do, from what the host itself advertised.
 *
 * Nothing is inferred. A capability the Mac did not claim is a capability it
 * does not have, because the failure of guessing is not a missing feature — it
 * is a run queued at a machine that cannot do the work, which looks exactly
 * like a run about to start.
 *
 * `local_apps` is the one derived entry, and it is derived from the list the
 * user filled in rather than from a toggle: app control with an empty allowlist
 * can drive nothing, so advertising it would offer a capability whose every
 * use is refused.
 */
function hostCapabilityView(host: WorkHost, now: Date): HostCapabilityView {
  const capabilities: WorkCapability[] = [];
  if (host.allowsFileWork) capabilities.push("local_files");
  if (host.allowsBrowser) capabilities.push("local_browser");
  if (host.allowsComputerUse) capabilities.push("local_computer_use");
  if (host.allowsShell) capabilities.push("local_shell");
  if (host.allowsBackground) capabilities.push("background_continuation");
  if (Array.isArray(host.allowedApps) && host.allowedApps.length > 0) capabilities.push("local_apps");

  return {
    hostId: host.id,
    displayName: host.displayName,
    state: effectiveHostState(host, now),
    enabled: host.enabled,
    revoked: host.revokedAt !== null,
    capabilities,
  };
}

/** Narrows a TEXT column to the vocabulary, falling back the way
 *  `serializers.ts` does: never widen a value this build cannot read. */
function targetOf(value: string): WorkTarget {
  return (WORK_TARGETS as readonly string[]).includes(value) ? (value as WorkTarget) : "automatic";
}

function policyOf(value: string): WorkPermissionPolicy {
  return (WORK_PERMISSION_POLICIES as readonly string[]).includes(value)
    ? (value as WorkPermissionPolicy)
    : "conservative";
}

interface RunModel {
  /** What was asked for, verbatim, including the Auto sentinel. */
  requested: string;
  /** A concrete `provider:model` the executor can split and drive. */
  effective: string;
  degradation: WorkDegradation[];
}

/** The reader-facing name of a model id, or the id when nothing knows it. */
function modelLabel(id: string): string {
  return resolveModel(id)?.name ?? id;
}

/**
 * Raised when the account's plan admits no model the agent runtime can drive.
 *
 * Distinct from the throw `pickAutoModel` makes, and answered differently: that
 * one means the deployment has no provider configured, which is nobody's fault
 * on this side of the request, while this one means the reader is not entitled
 * to any model that could run a Work task. One is a 503 and one is a 403, and
 * telling a person to "try again later" when the answer is "this needs a plan"
 * is how a wall gets mistaken for a wobble.
 */
class NoEntitledModelError extends Error {}

/**
 * Raised when this deployment can reach no model the agent runtime can drive —
 * every lab that carries one is unconfigured.
 *
 * The other half of the pair above, and the reason the router is not allowed to
 * answer both with a bare `null`: one of these is a wall in front of the reader
 * and the other is a wall in front of the operator, and telling somebody to
 * upgrade their plan when the truth is that nobody set an API key sends them to
 * a checkout page that will not help.
 */
class NoReachableModelError extends Error {}

/**
 * Decides which model this attempt actually runs on, before the row is written.
 *
 * This is the fix for a bug that killed every cloud run started from a browser.
 * `scripts/work-runner.ts` resolves its provider by splitting the run's model id
 * on `:`, and an empty string throws — "The run has no model" — before the first
 * token. Nothing had ever written `effectiveModel`, and no web client had ever
 * sent `model`, so every one of those runs died in `preparing`. Dispatch is the
 * right place to end that: it is the only layer holding the goal (which Auto
 * routes on), the account (whose plan bounds the choice), and the authority to
 * refuse rather than queue something that cannot run.
 *
 * Auto is resolved here rather than passed through. The sentinel is a promise to
 * choose, and choosing needs `isProviderConfigured`, which only the server can
 * answer. Resolving it is emphatically NOT a substitution and records no
 * degradation: the reader asked to be routed, and being routed is the answer to
 * that request, not a shortfall in it. A degradation on every Auto run would
 * teach people to ignore the one that matters.
 *
 * What IS a substitution is a model this run cannot actually have — either one
 * the agent runtime cannot drive, or one the account is not entitled to. The run
 * proceeds on the best model the account may actually use and says so, because a
 * run that quietly used a different model from the one on its own detail page is
 * a result nobody can account for afterwards.
 *
 * **Auto routes through `pickWorkModel`, not `pickAutoModel`.** It used to be
 * the latter, and that is the whole of how the reported incident began. The chat
 * router grades a sentence for the job chat does and ranks the survivors
 * cheapest-first; asked to route "clean my github & add readme on projects that
 * doesn't have one" it scored `simple` / `minIntelligence: 4` and returned the
 * cheapest model in the catalog clearing a 4 — measured on this catalog, one
 * billing an average of zero, which is a free tier, which is the tier with the
 * tightest rate limits. The run made one tool call and died against a 429 it had
 * no way to survive. `pickWorkModel` states Work's own floor, ranks within the
 * pool this deployment can actually reach, and breaks ties on capability rather
 * than on the first letter of a marketing name. See `src/lib/work/models.ts`.
 *
 * Two different throws, answered two different ways by the caller.
 * ``NoReachableModelError`` means no lab carrying a drivable model is configured
 * — a 503, nobody's fault on this side. ``NoEntitledModelError`` means the
 * account's plan admits no model that could run a Work task at all — a 403, and
 * a different sentence.
 */
function resolveRunModel(input: {
  requested: string;
  goal: string;
  plan: Plan;
  /** Models earlier attempts at this task already failed on. Auto only. */
  spentModels?: readonly string[];
}): RunModel {
  const providers = configuredProviders();
  const spent = input.spentModels ?? [];

  // Asked before anything else, because "this deployment can reach no drivable
  // model" and "your plan includes no drivable model" are the 503 and the 403,
  // and a single null from the router below cannot tell them apart. Reading the
  // reachable pool first is what keeps those two answers distinct.
  if (workModelOptions(MODEL_LIST, { providers }).length === 0) {
    throw new NoReachableModelError();
  }

  const auto = isAutoModelId(input.requested);

  if (auto) {
    // A retry of a task that already failed on one or more models moves to a
    // different lab rather than repeating the attempt that just died. The
    // ordering prefers a provider this task has not met yet, because the failure
    // this exists for — a rate limit — belongs to the lab and not to the model,
    // and the second-best model on the same key meets the same quota.
    if (spent.length > 0) {
      const [next] = workFailoverModels({
        goal: input.goal,
        plan: input.plan,
        models: MODEL_LIST,
        providers,
        exclude: spent,
      });
      if (next) {
        const previous = modelLabel(spent[0]);
        return {
          requested: input.requested,
          effective: next.id,
          degradation: [
            {
              kind: "model_substituted",
              subject: next.id,
              explanation:
                spent.length === 1
                  ? `The last attempt failed on ${previous}, so this one runs on ${next.name} instead.`
                  : `Earlier attempts failed on ${spent.length} other models, so this one runs on ${next.name}.`,
            },
          ],
        };
      }
      // Nothing left to move to. Falling through runs the ordinary choice again,
      // which is right: a task whose whole eligible pool has failed should still
      // be allowed one more go rather than be refused, and the reader pressed
      // the button knowing the last attempt failed.
    }

    const pick = pickWorkModel({
      goal: input.goal,
      plan: input.plan,
      models: MODEL_LIST,
      providers,
    });
    if (!pick) throw new NoEntitledModelError();
    return {
      requested: input.requested,
      effective: pick.model.id,
      // Routing is the answer to the request rather than a shortfall in it, so
      // an ordinary Auto run records nothing — see the docstring. The single
      // exception is a floor that could not be met, because that genuinely
      // changes what the reader should expect the run to get through.
      degradation: pick.relaxed
        ? [
            {
              kind: "model_substituted",
              subject: pick.model.id,
              explanation: `This task reads like it needs a more capable model than your plan includes, so it runs on ${pick.model.name}. It may take more steps, or stop short of the whole job.`,
            },
          ]
        : [],
    };
  }

  // A model the reader named. `isWorkModelAllowed` has already vetted the plan
  // for it; this re-checks on the resolved id, which is the only id worth
  // checking once `resolveModel` has had the chance to migrate a retired one.
  const info = resolveModel(input.requested);
  if (info && isWorkCapableModel(info) && canUseModel(input.plan, info.id)) {
    return { requested: input.requested, effective: info.id, degradation: [] };
  }

  const fallback = pickWorkModel({
    goal: input.goal,
    plan: input.plan,
    models: MODEL_LIST,
    providers,
  });
  if (!fallback) throw new NoEntitledModelError();

  const why =
    info && isWorkCapableModel(info)
      ? `${modelLabel(input.requested)} is not included in your plan`
      : `${modelLabel(input.requested)} cannot be driven as an agent`;

  return {
    requested: input.requested,
    effective: fallback.model.id,
    degradation: [
      {
        kind: "model_substituted",
        subject: input.requested,
        explanation: `${why}, so this task runs on ${fallback.model.name} instead.`,
      },
    ],
  };
}

/** A refusal: nothing was started, so there is no run to describe. */
function refused(status: number, body: Record<string, unknown>, preflight: WorkCostEstimate | null = null): StartWorkRunResponse {
  return { status, body, run: null, preflight };
}

/**
 * Starts an attempt at a task, or answers with the one this idempotency key
 * already started.
 *
 * The body of `POST /api/work/sessions/[id]/runs` after authentication, the
 * session lookup and parsing. `session` must already be the caller's own,
 * undeleted row: the route finds it with `userId: user.id, deletedAt: null`,
 * and the chat tool gets it back from `createWorkSessionForUser`.
 *
 * `preflightOnly` answers every question up to and including the cost estimate
 * (plan, usage window, executor, model), adds an unlocked read of the
 * concurrency cap, and then stops before the rate limit and before anything is
 * written, so a caller can put the estimate in front of a person first. Only
 * the chat tool asks for it; the route never does, and a preflight answer is
 * never a response body anybody decodes.
 */
export async function startWorkRunForUser(
  user: WorkDispatchUser,
  session: WorkSession,
  body: StartWorkRunBody,
  options: { preflightOnly?: boolean } = {}
): Promise<StartWorkRunResponse> {
  // Idempotency is checked before the rate limit and before the cap, so a
  // client retrying a dispatch whose response it never saw gets its run back
  // rather than a 429 for asking twice. `createRun` re-checks the same key
  // under its own unique index; this read is what keeps the retry off the abuse
  // controls, which count attempts, not runs.
  if (body.idempotencyKey) {
    const existing = await prisma.workRun.findFirst({
      where: { userId: user.id, idempotencyKey: body.idempotencyKey },
    });
    if (existing) {
      return { status: 200, body: { run: serializeRun(existing), replay: true }, run: existing, preflight: null };
    }
  }

  // The plan gate, on the id this attempt would actually ask for. The session's
  // stored model is checked too, not just the body's: a session drafted while
  // the account was on Pro is still there after it lapses, and dispatching it
  // would be a paid model started by an unpaid account without anybody choosing
  // that. `protocol.ts` deliberately does not check the model against the
  // catalog — the executor may substitute, and a rolling deploy legitimately
  // sees ids this build does not carry — but that is a question about whether
  // the id exists, and this is a question about whether this reader may use it.
  const requestedModel = body.model ?? session.requestedModel ?? defaultWorkModelId();
  const plan = await getUserPlan(user.id);
  if (!isWorkModelAllowed(requestedModel, plan)) {
    return refused(403, {
      error: "plan_locked",
      message: "Your plan does not include that model, so nothing was started. Pick another one, or upgrade.",
    });
  }

  /*
   * What this account has left in the window that binds it.
   *
   * This is the ceiling now. There is no per-run figure any more — a run goes
   * until the work is done or until the account's rolling 5-hour or weekly
   * window is used up — so this one read does two jobs: it refuses the dispatch
   * when the window is already spent, and its remainder becomes the run's cost
   * ceiling, which is what the executor's own guard stops a runaway loop at.
   *
   * Refused here rather than inside `createRun`, because the sentence a reader
   * gets has to name the window and when it frees up. "Over the ceiling" sends
   * somebody to the pricing page; "out of budget until 14:00" sends them to
   * lunch, and only one of those is true.
   */
  const windows = await checkUsageWindows(user.id, plan);
  if (!windows.allowed && windows.bound !== null) {
    return refused(429, {
      error: "usage_window_exceeded",
      message: `${windowLimitMessage(windows.bound, windows.resetsAtMs)} Nothing was started.`,
      window: windows.bound,
      resetsAtMs: windows.resetsAtMs,
    });
  }

  const now = new Date();
  const hosts = await prisma.workHost.findMany({ where: { userId: user.id } });
  // Preferred host first: `selectTarget` picks the first fully capable host in
  // the list, so this is how "run it on the MacBook" is expressed to it.
  const ordered = session.preferredHostId
    ? [...hosts].sort((left, right) =>
        left.id === session.preferredHostId ? -1 : right.id === session.preferredHostId ? 1 : 0
      )
    : hosts;

  const hasAgentComputer = session.agentId
    ? (await prisma.agentComputer.findFirst({
        where: { userId: user.id, agentId: session.agentId },
        select: { id: true },
      })) !== null
    : false;
  const requestedTarget =
    hasAgentComputer && (body.requestedTarget ?? targetOf(session.requestedTarget)) === "automatic"
      ? "cloud"
      : body.requestedTarget ?? targetOf(session.requestedTarget);
  const explicit = body.requiredCapabilities ?? [];
  const offers = ordered.map((host) => hostCapabilityView(host, now));
  const required: readonly WorkCapability[] =
    explicit.length > 0
      ? explicit
      : inferCapabilities(session.goal, { hasAgentComputer }).capabilities;
  const selection =
    explicit.length > 0
      ? selectTarget({
          requested: requestedTarget,
          required,
          hosts: offers,
          cloudAvailable: CLOUD_WORK_AVAILABLE,
        })
      : selectForInferred({
          requested: requestedTarget,
          inferred: required,
          hosts: offers,
          cloudAvailable: CLOUD_WORK_AVAILABLE,
          hasAgentComputer,
        });

  // No executor can serve this. Refusing is the entire reason `selectTarget`
  // returns a null target: a queued run with nothing able to claim it is a
  // spinner that never resolves, and this 409 is the only moment anything in
  // the system is in a position to tell the user why. The explanation is passed
  // through untouched — it already names the Mac and its state, in the words
  // the user is shown.
  const refusal = refusalForSelection(selection);
  if (refusal) return refused(409, { ...refusal });

  // Before the rate limit, because a deployment with no configured provider is
  // not the reader's fault and should not cost them one of their ten runs a
  // minute to discover.
  /*
   * Models this task has already burned an attempt on.
   *
   * This is failover, and it is deliberately here rather than inside the agent
   * loop. Swapping a model mid-run cannot be done honestly: `provider` and
   * `model` are fixed `AgentLoopOptions`, and three things are bound alongside
   * them at construction — the budget guard's `pricing`, the reasoning tier
   * clamped for the old model's enum, and the `run_started` event that already
   * told the transcript which model was answering. A mid-loop swap would bill
   * the new model's tokens at the old one's rate, risk an instant 400 from a lab
   * whose thinking dialect differs, and leave the record naming a model that
   * stopped being true. A new attempt has none of those problems, because every
   * one of them is rebuilt.
   *
   * Only for Auto. A reader who named a model is owed that model or a refusal —
   * quietly running their task somewhere else is the substitution the whole
   * degradation vocabulary exists to prevent. And only across *failed* attempts:
   * a cancelled run was somebody's decision, not the model's failure.
   */
  const spentModels = isAutoModelId(requestedModel)
    ? (
        await prisma.workRun.findMany({
          where: {
            sessionId: session.id,
            userId: user.id,
            status: { in: ["failed", "timed_out"] },
          },
          select: { effectiveModel: true },
          orderBy: { attempt: "desc" },
          take: MAX_FAILOVER_HISTORY,
        })
      )
        .map((run) => run.effectiveModel)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];

  let model: RunModel;
  try {
    model = resolveRunModel({
      requested: requestedModel,
      goal: session.goal,
      plan,
      spentModels,
    });
  } catch (err) {
    if (err instanceof NoEntitledModelError) {
      return refused(403, {
        error: "plan_locked",
        message:
          "Your plan doesn’t include a model that can run a Work task, so nothing was started.",
      });
    }
    // `NoReachableModelError`, or anything unexpected out of the router. The
    // only honest answer is that nothing was started and the reason is on this
    // side: a 500 would send the reader to retry a request that cannot succeed
    // until somebody configures a provider.
    return refused(503, {
      error: "no_model_available",
      message: "Juno has no model available to run this right now, so nothing was started.",
    });
  }

  const preflight = estimateWorkRunCost({ modelId: model.effective, goalChars: session.goal.length });
  // Everything a person could be refused for has been asked, and nothing has
  // been written or counted against the rate limit. This is where a caller that
  // shows the estimate before starting gets it.
  if (options.preflightOnly) {
    // The concurrency cap as well, read without its lock. The transaction
    // below is still what enforces it; this only keeps a caller from asking a
    // person to approve a run the cap would refuse the moment they said yes,
    // which for somebody with three tasks going is the common case, not a race.
    const live = await prisma.workRun.count({
      where: { userId: user.id, status: { in: [...WORK_LIVE_STATUSES] } },
    });
    if (live >= WORK_RUN_CONCURRENCY_CAP) {
      return refused(
        429,
        {
          error: "run_cap_exceeded",
          message: `You already have ${live} runs in progress. Let one finish first.`,
        },
        preflight
      );
    }
    return { status: 200, body: { preflight }, run: null, preflight };
  }
  if (preflight.requiresConfirmation && !body.confirmExpensive) {
    return refused(
      409,
      {
        error: "expensive_confirmation_required",
        message: `This task is estimated at about $${(preflight.estimatedCostMicroUsd / 1_000_000).toFixed(2)} before it starts. Confirm to use the Work budget and continue.`,
        confirmation: {
          kind: "expensive_work",
          estimatedCostMicroUsd: preflight.estimatedCostMicroUsd,
          modelId: preflight.modelId,
        },
      },
      preflight
    );
  }

  if (!isOwnerEmail(user.email)) {
    const limited = await rateLimit({
      key: `work-run:${user.id}`,
      limit: WORK_RUN_RATE_LIMIT,
      windowSec: 60,
    });
    if (!limited.success) {
      return refused(429, { error: "Too many runs started. Try again shortly." }, preflight);
    }
  }

  const host = selection.hostId ? hosts.find((candidate) => candidate.id === selection.hostId) : undefined;
  // The approval mode this attempt runs under, after narrowing.
  //
  // `resolveApprovalMode` is a `min` over the request and the Mac, so no layer
  // can widen another: a host pinned to Manual stays Manual under a session set
  // to Skip, which is what makes the toggle on the Mac mean anything at all. The
  // body may name a mode for this attempt alone — "it stopped to ask me nine
  // times, run it again and stop asking" — and it goes through the same
  // intersection, so the widest a client can reach is the Mac's own setting.
  //
  // Stored with its inputs because the approval digests are taken over this
  // exact blob, and an approval granted under one mode must be provably
  // distinguishable from the same approval under another.
  const requestedPolicy = body.permissionPolicy ?? policyOf(session.permissionPolicy);
  const mode = resolveApprovalMode({
    requested: requestedPolicy,
    host: host ? policyOf(host.approvalPolicy) : null,
    hostName: host?.displayName ?? null,
  });
  const permissionPolicy: Prisma.InputJsonValue = {
    policy: mode.policy,
    // Each key names the layer it came from, so `session` stays the session's
    // own stored mode even when the body overrode it for this attempt; the
    // override goes in `requested`, and only when there was one. A run
    // dispatched without the new control therefore canonicalises byte-for-byte
    // to what this route has always written. That matters: `policyDigest` is
    // taken over this blob, and adding a key unconditionally would have refused
    // every approval in flight across the deploy with `policy_changed` —
    // failing closed, but closed on a question nobody had changed the answer to.
    session: policyOf(session.permissionPolicy),
    host: mode.host,
    ...(body.permissionPolicy ? { requested: body.permissionPolicy } : {}),
  };

  // The instruction that will actually drive this run, decided before anything
  // is written.
  //
  // A run dispatched to a Mac used to reach `queued` and stop there for ever.
  // `POST /api/work/hosts/[id]/commands` was the only writer of the command
  // queue and nothing here called it, so the Mac long-polled correctly and
  // indefinitely for a `start` that was never enqueued — which is a spinner
  // that never resolves, arriving one layer below the one `selectTarget`
  // exists to prevent.
  //
  // Planned here rather than inside the transaction so that a refusal costs
  // nothing: `selectTarget` has already excluded a Mac that is disabled or
  // revoked, but it read the fleet a few statements ago, and a revocation that
  // landed in between must stop the dispatch rather than leave a run behind
  // with no instruction. Creating the run first and refusing afterwards would
  // be exactly the orphan this whole change exists to make impossible.
  const dispatch = planRunCommand({
    effectiveTarget: selection.target,
    host: host ?? null,
    kind: "start",
  });
  if (dispatch.plan === "refuse") {
    return refused(dispatch.refusal.status, refusalBody(dispatch.refusal), preflight);
  }
  const command: RunDrivingCommand | undefined =
    dispatch.plan === "enqueue"
      ? {
          hostId: dispatch.hostId,
          kind: "start",
          // The goal comes off the session, which is where the user's own words
          // live; the model is the concrete id resolved above, never the Auto
          // sentinel, because the Mac splits it into a provider and a name and
          // has no catalogue to resolve a sentinel against. The mode is the
          // already-narrowed one — the same value written onto the run and
          // digested into every approval — so the Mac enforces what this task
          // was dispatched under rather than its own standing setting.
          payload: startCommandPayload({
            goal: session.goal,
            model: model.effective,
            permissionPolicy: mode.policy,
          }),
        }
      : undefined;

  let created: CreateRunResult;
  try {
    created = await prisma.$transaction(async (tx) => {
      // The cap and the create are serialised per user by a transactional
      // advisory lock, because a plain count-then-create is a TOCTOU: N
      // parallel dispatches each read a count under the cap and all create.
      //
      // Two details are deliberate. It is the `try` variant, so a second
      // dispatch fails fast instead of queueing — a queue of waiters would each
      // hold a pooled connection while the holder needs a second one for
      // `createRun`, which exhausts the pool under exactly the burst this guard
      // exists for. And `createRun` is called from inside this callback even
      // though it opens its own transaction: that transaction commits before
      // this one releases the lock, so the next dispatch through here counts
      // the run this one just made. Moving the insert inline would mean
      // reimplementing attempt allocation and idempotency recovery, and those
      // are the two things that must never disagree with the store.
      const [lock] = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtext(${`work-run-cap:${user.id}`})) AS locked
      `;
      if (!lock?.locked) throw new Error("dispatch_in_flight");

      const live = await tx.workRun.count({
        where: { userId: user.id, status: { in: [...WORK_LIVE_STATUSES] } },
      });
      if (live >= WORK_RUN_CONCURRENCY_CAP) {
        throw Object.assign(new Error("run_cap_exceeded"), { liveCount: live });
      }

      // One live run per session. A second attempt started while the first is
      // still going means two executors planning against one goal and writing
      // to the same granted folders, and the user watching one transcript while
      // two things happen. Retrying means cancelling first, which is a decision
      // only they can make.
      const alreadyLive = await tx.workRun.count({
        where: { sessionId: session.id, userId: user.id, status: { in: [...WORK_LIVE_STATUSES] } },
      });
      if (alreadyLive > 0) throw new Error("session_already_running");

      return createRun({
        sessionId: session.id,
        userId: user.id,
        origin: body.origin ?? "manual",
        requestedTarget,
        effectiveTarget: selection.target,
        hostId: selection.hostId,
        // Both, always. `requestedModel` is what was asked for and may be the
        // Auto sentinel; `effectiveModel` is the concrete id the executor
        // splits into a provider and a model name. Keeping only one of them
        // would lose the difference between a run that asked for Opus and a run
        // that asked to be routed and was routed to it.
        requestedModel: model.requested,
        effectiveModel: model.effective,
        requiredCapabilities: required,
        availableCapabilities: selection.available,
        // Carried onto the run so the client can show, before any work starts,
        // that this attempt will do less than was asked. Recomputing it later
        // describes the fleet as it is then, not as it was at dispatch. The
        // model's degradation joins the target's here rather than being kept
        // apart: from the reader's side there is one list of ways this run
        // differs from the one they asked for.
        degradation: [...selection.degradation, ...model.degradation],
        permissionPolicy,
        // The ceilings the executor's budget guard enforces and the three bars
        // in the UI read. Written at dispatch rather than derived later,
        // because an approval digest and a budget bar both have to describe
        // the run as it was started, not as the defaults happen to be today.
        //
        // Shaped by the window, from the same read the gate above was made on.
        // The remainder becomes the run's cost ceiling, so the executor's guard
        // stops a runaway loop at exactly the point the account runs out of
        // window; tokens and runtime carry no ceiling at all. Reading the
        // window twice would let a chat turn land between the two reads and
        // refuse a run against one number while the guard measured it against
        // another.
        budget: runBudgetForWindow(windows.remainingMicroUsd),
        // The plan, handed on to spend admission rather than left for it to
        // read again — a lapse between two reads would measure the run against
        // a plan it was not admitted under.
        plan,
        idempotencyKey: body.idempotencyKey ?? null,
        // Written in the run's own transaction, so this attempt cannot exist
        // without the instruction that drives it, nor the instruction without
        // the run it names.
        command,
      });
    });
  } catch (err) {
    if (err instanceof WorkSpendAdmissionError) {
      // The monthly ceiling, which sits outside the windows the gate above
      // reads. `refusedBy: "unit"` no longer reaches here for Work — there is
      // no per-run ceiling to be above — but the branch stays because the
      // sentence has to be right if a per-unit ceiling is ever filed for this
      // kind again, and a refusal with the wrong explanation is worse than a
      // dead branch.
      const message =
        err.result.refusedBy === "unit"
          ? "This task is above Juno’s per-run spending ceiling, so nothing was started. Lower its scope or choose a less expensive model."
          : "Starting this task would exceed your monthly spending ceiling, so nothing was started. Finish or stop another run, or raise the account cap.";
      return refused(
        429,
        {
          error: "spend_cap_exceeded",
          message,
          budgetMicroUsd: err.result.budgetMicroUsd,
          remainingMicroUsd: err.result.remainingMicroUsd,
          estimateMicroUsd: err.result.estimateMicroUsd,
          capSource: err.result.capSource,
        },
        preflight
      );
    }
    if (err instanceof Error && err.message === "dispatch_in_flight") {
      return refused(
        429,
        { error: "dispatch_in_flight", message: "Another run is being started. Try again in a moment." },
        preflight
      );
    }
    if (err instanceof Error && err.message === "run_cap_exceeded") {
      const live = (err as Error & { liveCount?: number }).liveCount ?? WORK_RUN_CONCURRENCY_CAP;
      return refused(
        429,
        {
          error: "run_cap_exceeded",
          message: `You already have ${live} runs in progress. Let one finish first.`,
        },
        preflight
      );
    }
    if (err instanceof Error && err.message === "session_already_running") {
      return refused(
        409,
        {
          error: "session_already_running",
          message: "This session is already running. Cancel it before starting another attempt.",
        },
        preflight
      );
    }
    throw err;
  }

  if (!created.replay) {
    // The files this attempt is being given, frozen onto the run. Skipped on a
    // replay because a replayed dispatch is the same run, and its manifest was
    // written when the run was — writing it twice would show the reader every
    // attachment twice for no reason they could work out.
    await recordRunInputsFromGrants({
      runId: created.run.id,
      sessionId: session.id,
      userId: user.id,
    });

    // The thinking depth, when this attempt asked for one. It lands on the
    // session rather than the run because `WorkRun` has no column for it, which
    // means — unlike `requestedTarget` — it is not attempt-scoped: setting it
    // here changes it for the next attempt too. That is a schema gap, not a
    // decision, and it is written down here rather than left to be rediscovered
    // by whoever notices their retry thinking as hard as the run before it.
    if (body.reasoningEffort !== undefined && body.reasoningEffort !== session.reasoningEffort) {
      await prisma.workSession.updateMany({
        where: { id: session.id, userId: user.id },
        data: { reasoningEffort: body.reasoningEffort },
      });
    }
  }

  return {
    status: created.replay ? 200 : 201,
    body: {
      run: serializeRun(created.run),
      selection: {
        target: selection.target,
        hostId: selection.hostId,
        explanation: selection.explanation,
        missing: selection.missing,
        degradation: selection.degradation,
      },
      // The mode this attempt will actually run under, answered at the moment
      // it is decided. The composer needs it because the one thing it must not
      // do is show Skip on a task that is about to run Manual — a person who
      // chose Skip and then watches it stop to ask has been lied to by a
      // control, and the honest version of that is a sentence naming the Mac
      // that narrowed it. `explanation` is that sentence, already addressed to
      // the reader.
      //
      // Only the resolved shape goes out, never the stored blob: that blob is
      // what the executor enforces and what the approval digests are taken over,
      // and a client that renders it is one refactor away from a client that
      // submits it.
      approvalMode: {
        policy: mode.policy,
        requested: mode.requested,
        narrowedByHost: mode.narrowedByHost,
        explanation: mode.explanation,
      },
      ...(created.replay ? { replay: true } : {}),
      preflight,
    },
    run: created.run,
    preflight,
  };
}

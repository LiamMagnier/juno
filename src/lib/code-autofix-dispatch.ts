import "server-only";
import { Prisma } from "@prisma/client";

import { prismaUnguarded } from "@/lib/prisma";
import { env } from "@/lib/env";
import { encryptMessageText } from "@/lib/message-crypto";
import { appendTaskEvents, persistCodeTaskOutcome } from "@/lib/code-remote";
import { CloudDispatchError, dispatchCloudRunner, getCloudRunnerReadiness } from "@/lib/cloud-code";
import { STEERABLE_STATUSES, canSteerRun } from "@/lib/code-steer-policy";
import {
  AUTO_FIX_SKIP_NOTE,
  autoFixDispatchNote,
  autoFixSessionMessage,
  autoFixSteerNote,
  autoFixTaskTitle,
  buildAutoFixPrompt,
  type AutoFixEvent,
  type AutoFixSkipReason,
} from "@/lib/code-autofix";

/*
 * TURNING A VERIFIED DELIVERY INTO A RUN.
 *
 * The reading of the delivery is pure (src/lib/code-autofix.ts) and the
 * signature gate is pure (src/lib/github-app.ts); this is the part that touches
 * the database and GitHub, so it is the part that has to be careful about what
 * it is allowed to do.
 *
 * ── WHY THIS IS NOT `POST /api/code/tasks` ─────────────────────────────────
 *
 * The create route is a composer's route: it authenticates a session, accepts
 * attachments, resolves a title, takes an environment and a permission mode
 * from a picker, and refuses half of that for a device target. None of it
 * applies here. There is no signed-in person on a webhook — the author of the
 * event is a stranger — so every one of those decisions is instead INHERITED
 * from the run that opened the pull request, which is the only run whose owner
 * ever consented to anything. What is left is small enough to read in one
 * screen, and what it deliberately keeps from the create route is spelled out
 * below, function by function.
 *
 * ── WHAT A WEBHOOK MAY DECIDE, AND WHAT IT MAY NOT ─────────────────────────
 *
 * It may decide: that an event happened, and that a run should look at it.
 *
 * It may NOT decide: the repository, the branch, the base, the environment, the
 * permission mode or the model. Every one of those is copied from the anchor
 * task — the newest cloud run in the watched conversation — precisely so that
 * nothing in a comment body can move the run somewhere its owner did not point
 * it. A comment saying "push to main" reaches the model as fenced text, and the
 * branch it would have to change is a column this function has already written.
 *
 * ── THERE IS NO ATTEMPT CEILING HERE, AND THAT IS DELIBERATE ───────────────
 *
 * The obvious guard is "at most N auto-fixes per pull request". It is the wrong
 * guard. A cap answers a pricing question with a correctness mechanism, and it
 * fails in the direction that hurts: the fifth failing check is exactly as real
 * as the first, and a run that stops because of a counter leaves a branch
 * broken with nothing said. What IS enforced is serialisation — one auto-fix
 * run per branch at a time, because two runs pushing to one branch race, with a
 * second event handed to the run already going as a `steer` rather than dropped
 * — and the duplicate guard, which refuses to answer the same evidence twice.
 * Everything else is bounded by the account's own usage window, which is the
 * only ceiling this product has and the only one a person can see.
 */

/** What became of one delivery, for the row that records it. */
export type AutoFixOutcome =
  | { outcome: "dispatched"; taskId: string; note: string }
  | { outcome: "steered"; taskId: string; note: string }
  | { outcome: "skipped"; reason: AutoFixSkipReason; note: string };

/**
 * Every watch this delivery is about.
 *
 * Matched by pull request number, and by branch ONLY when the delivery named no
 * pull request — the two are not an OR. A branch outlives the pull request it
 * was opened for: reopen a second one on the same ref and an OR would answer
 * both watches, which is two runs pushing to one branch from two conversations.
 * The number is the precise identity and is present on everything except a
 * check run whose `pull_requests` GitHub left empty, so the fallback is exactly
 * as narrow as the case that needs it.
 *
 * `enabled` is part of the query rather than a later check: a row that exists
 * and is off must be indistinguishable here from a row that does not exist, or
 * a delivery for a pull request someone once watched would still cost a read of
 * their conversation.
 */
export async function findAutoFixWatches(event: AutoFixEvent) {
  const identity: Prisma.CodeAutoFixWatchWhereInput | null =
    event.prNumber !== null
      ? { prNumber: event.prNumber }
      : event.headBranch
        ? { branch: event.headBranch }
        : null;
  if (!identity) return [];
  return prismaUnguarded.codeAutoFixWatch.findMany({
    where: {
      // Repository names are case-insensitive on GitHub and a delivery may not
      // spell them the way the toggle did.
      repoOwner: { equals: event.repo.owner, mode: "insensitive" },
      repoName: { equals: event.repo.name, mode: "insensitive" },
      enabled: true,
      ...identity,
    },
    select: { id: true, userId: true, conversationId: true },
  });
}

/**
 * Answer one delivery for one watch.
 *
 * The delivery row is written FIRST, on the unique (watchId, digest), and that
 * ordering is the duplicate guard. Two deliveries of the same check run can
 * arrive concurrently — GitHub retries, and a re-run posts to several
 * subscribers — and a read-then-write would let both pass the check and both
 * dispatch a run against one branch. The loser of the insert is told it is a
 * duplicate by the database, which is the only participant that can know.
 */
export async function answerAutoFixDelivery(input: {
  watch: { id: string; userId: string; conversationId: string | null };
  event: AutoFixEvent;
}): Promise<AutoFixOutcome | null> {
  const { watch, event } = input;

  let deliveryId: string;
  try {
    const row = await prismaUnguarded.codeAutoFixDelivery.create({
      data: {
        watchId: watch.id,
        digest: event.digest,
        trigger: event.trigger,
        // Written as a skip and promoted on success: a row that claimed
        // "dispatched" before the dispatch happened would survive a crash as a
        // lie, and this table is what a person reads to find out what Juno did.
        outcome: "skipped",
        reason: "dispatch_failed",
        note: AUTO_FIX_SKIP_NOTE.dispatch_failed,
      },
      select: { id: true },
    });
    deliveryId = row.id;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Already answered. Nothing is recorded a second time — the first row is
      // the note, and a duplicate of a duplicate is not news.
      return null;
    }
    throw err;
  }

  const settle = async (result: AutoFixOutcome): Promise<AutoFixOutcome> => {
    await prismaUnguarded.codeAutoFixDelivery.update({
      where: { id: deliveryId },
      data:
        result.outcome === "skipped"
          ? { outcome: "skipped", reason: result.reason, note: result.note }
          : { outcome: result.outcome, reason: null, note: result.note, taskId: result.taskId },
    });
    return result;
  };
  const skip = (reason: AutoFixSkipReason) => settle({ outcome: "skipped", reason, note: AUTO_FIX_SKIP_NOTE[reason] });

  if (!watch.conversationId) return skip("no_session");

  /*
   * THE ANCHOR. The newest cloud run in this conversation is where every fact
   * about the follow-up comes from — repository, branch, base, environment,
   * permission mode, model, effort. It is the run whose owner chose those
   * things; the webhook chooses none of them.
   */
  const anchor = await prismaUnguarded.codeTask.findFirst({
    where: { userId: watch.userId, conversationId: watch.conversationId, target: "cloud" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      repoOwner: true,
      repoName: true,
      branch: true,
      baseRef: true,
      environmentId: true,
      permissionMode: true,
      model: true,
      reasoningEffort: true,
      workspaceName: true,
      workspaceKey: true,
    },
  });
  if (!anchor || !anchor.repoOwner || !anchor.repoName) return skip("no_session");
  /*
   * A branch is not optional. Without one the runner clones the base and
   * branches afresh, which would answer a review comment by opening a SECOND
   * pull request — the exact failure `continueOn` exists to prevent in the
   * create route.
   */
  const branch = anchor.branch ?? (await latestBranch(watch.userId, watch.conversationId));
  if (!branch) return skip("no_session");

  /*
   * A RUN IS ALREADY GOING, SO THIS ONE IS HANDED TO IT RATHER THAN DROPPED.
   *
   * One fix per branch at a time is not negotiable — two runs pushing to one
   * branch race, and the second works from a tree the first is about to rewrite
   * — but "skip the second event" would have been wrong in the commonest case
   * there is: a reviewer leaves five line comments at once, and four of them
   * would have been noted as skipped while the run answering the fifth never
   * heard about them.
   *
   * `steer` is the mechanism that already exists for exactly this: the control
   * is appended to the live task's stream, and the cloud driver folds it into
   * the agent's next step — or, for a run that has not started, reads it out of
   * the runner-context handoff and folds it into its opening prompt. It is
   * offered for a cloud run only, because a Mac host appends the control and
   * never reads it (`canSteerRun`, src/lib/code-steer-policy.ts), and telling a
   * person their event was delivered to something that ignored it is worse than
   * telling them it was skipped.
   */
  // Asked before the lock below, because it is a network probe and holding a
  // per-watch lock across one would serialise every delivery behind GitHub.
  const readiness = await getCloudRunnerReadiness();

  /*
   * LOOK AND WRITE UNDER ONE LOCK, the pattern `POST /api/code/tasks` uses for
   * its concurrency cap. Two deliveries about DIFFERENT evidence — a failing
   * lint and a failing test, posted a second apart — both pass a plain
   * "is anything running" read and both create a run, which is the very race
   * this check exists to prevent. The advisory lock is per watch and releases
   * on commit; a hash collision briefly serialises two unrelated pull requests.
   */
  const prompt = buildAutoFixPrompt(event);
  const decision = await prismaUnguarded.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`autofix:${watch.id}`}))`;
    const live = await tx.codeTask.findFirst({
      where: {
        userId: watch.userId,
        conversationId: watch.conversationId!,
        status: { in: [...STEERABLE_STATUSES] },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, target: true },
    });
    // STEERABLE_STATUSES is exactly the non-terminal set, so the only thing
    // `canSteerRun` can still refuse is a run on a Mac.
    if (live) return { kind: "live" as const, live };
    if (!readiness.ready) return { kind: "unavailable" as const };
    const created = await tx.codeTask.create({
      data: {
        userId: watch.userId,
        deviceId: null,
        target: "cloud",
        repoOwner: anchor.repoOwner!,
        repoName: anchor.repoName!,
        // Dispatched ONTO the branch, exactly as a follow-up typed in the
        // composer is: the runner checks it out, pushes to it and reuses the
        // open pull request rather than opening another.
        baseRef: branch,
        branch,
        workspacePath: `${anchor.repoOwner}/${anchor.repoName}`,
        workspaceName: anchor.workspaceName || anchor.repoName!,
        workspaceKey: anchor.workspaceKey,
        title: autoFixTaskTitle(event),
        prompt,
        conversationId: watch.conversationId,
        createsNewSession: false,
        origin: "cloud",
        model: anchor.model,
        reasoningEffort: anchor.reasoningEffort,
        environmentId: anchor.environmentId,
        permissionMode: anchor.permissionMode,
        // Idempotency on the EVIDENCE, belt to the delivery table's braces. The
        // two guards fail differently — one is per watch, one is per user — and
        // the cost of the second is a column that is already there.
        idempotencyKey: `autofix:${watch.id}:${event.digest}`.slice(0, 200),
      },
    });
    return { kind: "created" as const, task: created };
  });

  if (decision.kind === "unavailable") return skip("runner_unavailable");
  if (decision.kind === "live") {
    const { live } = decision;
    if (!canSteerRun(live.status, live.target)) return skip("fix_in_flight");
    await appendTaskEvents(live.id, [
      {
        kind: "steer",
        payload: { requestId: `autofix:${event.digest}`, text: prompt },
        // Idempotent on the evidence, so a retry cannot queue the same event
        // twice into a run that is reading its backlog.
        key: `steer:autofix:${event.digest}`,
      },
    ]);
    await writeSessionTurn(watch.conversationId, watch.userId, autoFixSessionMessage(event));
    return settle({ outcome: "steered", taskId: live.id, note: autoFixSteerNote(event) });
  }
  const task = decision.task;

  // The turn that explains the run, written before the dispatch for the same
  // reason the create route writes it before its own: a runner can start the
  // moment GitHub accepts, and a live task with no user turn above it is a
  // transcript that begins mid-sentence.
  await writeSessionTurn(watch.conversationId, watch.userId, autoFixSessionMessage(event));

  try {
    await dispatchCloudRunner({ taskId: task.id, callbackBase: env.appUrl.replace(/\/$/, "") });
  } catch (err) {
    console.error("[auto-fix] workflow_dispatch failed", err instanceof CloudDispatchError ? err.message : err);
    // Retain the task and mark it failed rather than deleting it: the user turn
    // above is already in the transcript, and a session that shows an ask with
    // no outcome is worse than one that shows an ask that failed.
    try {
      await appendTaskEvents(
        task.id,
        [
          {
            kind: "error",
            payload: { message: "Auto-fix could not start a cloud run. The branch was not changed." },
            key: `dispatch:${task.id}`,
          },
        ],
        { status: "failed", fromStatus: "queued" },
      );
      const failed = await prismaUnguarded.codeTask.findUnique({ where: { id: task.id } });
      if (failed) await persistCodeTaskOutcome(failed);
    } catch (reconcileErr) {
      console.error("[auto-fix] failed to reconcile a dispatch failure", reconcileErr);
    }
    return skip("dispatch_failed");
  }

  return settle({ outcome: "dispatched", taskId: task.id, note: autoFixDispatchNote(event) });
}

/** The newest branch any cloud run in this conversation pushed. */
async function latestBranch(userId: string, conversationId: string): Promise<string | null> {
  const row = await prismaUnguarded.codeTask.findFirst({
    where: { userId, conversationId, target: "cloud", branch: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { branch: true },
  });
  return row?.branch ?? null;
}

/**
 * The USER row that says why this run exists.
 *
 * A USER row rather than a system one, and the precedent is mid-run steering
 * (`POST /api/code/tasks/[id]/steer`), which persists an instruction the same
 * way: the transcript's unit is "what was asked, and what came back", and an
 * ask that arrived from GitHub is still an ask. What keeps it honest is the
 * text itself — `autoFixSessionMessage` names auto-fix in its first two words
 * and quotes the event rather than speaking for it.
 *
 * `updateMany` scoped by userId, not `update` by id: the conversation id
 * reached this function from a row the webhook found, and a webhook is never
 * allowed to write to a conversation on the strength of an id alone.
 */
async function writeSessionTurn(conversationId: string, userId: string, text: string): Promise<void> {
  try {
    await prismaUnguarded.$transaction(async (tx) => {
      const owned = await tx.conversation.count({ where: { id: conversationId, userId } });
      if (owned === 0) return;
      await tx.message.create({
        data: { conversationId, role: "USER", content: encryptMessageText(text) },
      });
      await tx.conversation.updateMany({
        where: { id: conversationId, userId },
        data: { lastMessageAt: new Date() },
      });
    });
  } catch (err) {
    // The run is the point; the transcript row is how a person follows it. A
    // failure here must not take the run down with it, but it must be visible
    // in the logs, because a run with no explanation above it is the defect
    // this feature is most likely to be blamed for.
    console.error("[auto-fix] failed to write the session turn", err);
  }
}

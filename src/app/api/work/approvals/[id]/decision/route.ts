import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { authenticateNativeBearer } from "@/lib/native-auth";
import { markRunNotificationsRead } from "@/lib/notifications";
import { isTerminalStatus, isWorkStatus } from "@/lib/work/domain";
import { recordWorkAudit } from "@/lib/work/audit";
import { appendEvents, dispatchRunCommand, requeueParkedRun, setSessionAttention } from "@/lib/work/store";
import { cloudWorkAvailable } from "@/lib/work/executor-heartbeat";
import { CLOUD_EXECUTOR_UNAVAILABLE_MESSAGE } from "@/lib/work/executor-presence";
import { currentRunState, waitsOnApproval } from "@/lib/work/park-resume";
import { approvalCommandKey } from "@/lib/work/relay";
import { serializeApproval, serializeCommand } from "@/lib/work/serializers";
import {
  approvalDecisionSchema,
  classifyApprovalDecision,
  type ApprovalDecisionRefusal,
} from "@/app/api/work/protocol";
import { PRODUCT_NAME } from "@/lib/brand/names";

export const runtime = "nodejs";

/**
 * What the client is told, per refusal.
 *
 * One sentence each, because each one needs a different thing from the user:
 * look at the card again, answer the question as it is now being asked, or
 * accept that the moment has passed. A single "could not be recorded" would
 * leave all three looking like a bug.
 */
const REFUSAL_MESSAGES: Record<ApprovalDecisionRefusal, string> = {
  digest_mismatch: "This approval is for a different action than the one you were shown.",
  policy_changed: `The permissions changed after you were asked. ${PRODUCT_NAME} will ask again.`,
  expired: "This request expired before it was answered.",
  already_decided: "This request has already been answered.",
  not_standing_allowable:
    `${PRODUCT_NAME} will not stop asking about this one. Allow it this time if you want it to happen.`,
};

/**
 * The refusal's sentence for this row, when the row says more than the reason.
 *
 * A request closed because the execution that asked it ended (`superseded`,
 * written by `closeAbandonedApprovals` in src/lib/work/park-resume.ts) is
 * refused as `already_decided` — the code clients already handle — but nobody
 * answered it, so saying "already answered" would send the person looking for
 * a decision nobody made. An expired request on a run that was parked on it is
 * put back in the queue so the task asks again (`continueAfterRefusal`).
 */
function refusalMessage(
  reason: ApprovalDecisionRefusal,
  storedDecision: string,
  askingAgain: boolean,
  declinedLapsed = false
): string {
  if (reason === "already_decided" && storedDecision === "superseded") {
    return `${PRODUCT_NAME} is no longer waiting on this request, so this answer was not recorded. Answer the one it is asking now.`;
  }
  if (reason === "expired" && askingAgain) return `${REFUSAL_MESSAGES.expired} ${PRODUCT_NAME} will ask again.`;
  if (reason === "expired" && declinedLapsed) {
    return `${REFUSAL_MESSAGES.expired} Nothing was done, and the task stays paused on it: stop it, or resume it to be asked again.`;
  }
  return REFUSAL_MESSAGES[reason];
}

/**
 * What the person is told when their decision is recorded but the run does not
 * carry on yet. Null when it does, or when there is nothing to add (a decision
 * on a request the run no longer waits on).
 */
const DECISION_KEPT_NO_EXECUTOR = `Your decision is saved. ${CLOUD_EXECUTOR_UNAVAILABLE_MESSAGE} Resume the task once it is back and it continues with your decision.`;
const DECISION_KEPT_PAUSED =
  "Your decision is saved. This task is paused, so it continues with your decision when you resume it.";

/**
 * Which client answered, in the Work actor vocabulary (`web | macos | ios`).
 *
 * `requireUser` already accepted the request, so a bearer on it is a native
 * app's — an invalid one would have been refused rather than read as the
 * browser. Its sign-in names the platform in the app's own words ("macOS",
 * "iOS", "iPadOS"; the older desktop build says "darwin"). A platform outside
 * those, or a lookup that fails now, says nothing about the decision, so it is
 * recorded as the web's rather than as a device it did not come from.
 */
async function decidingClient(req: Request): Promise<"web" | "macos" | "ios"> {
  const authorization = req.headers.get("authorization");
  if (!authorization) return "web";
  try {
    const { platform } = (await authenticateNativeBearer(authorization)).deviceSession;
    if (/mac|darwin/i.test(platform)) return "macos";
    if (/ios|ipad|iphone/i.test(platform)) return "ios";
    return "web";
  } catch {
    return "web";
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const parsed = approvalDecisionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { decision, actionDigest, reason } = parsed.data;

  const approval = await prisma.workApproval.findFirst({
    where: { id, userId: user.id },
    include: {
      // The policy in force RIGHT NOW, not the one the card was drawn under.
      // That difference is the whole point of `policyDigest`: an approval
      // granted while the session was permissive must not still authorise the
      // action after the user narrowed the session to conservative, because
      // narrowing it was aimed at exactly that action.
      // `hostId` and `effectiveTarget` are here for the dispatch at the end: a
      // decision that only lands in Postgres leaves the Mac holding the tool
      // call waiting on an answer it will never be handed.
      run: {
        select: {
          id: true,
          sessionId: true,
          status: true,
          pauseReason: true,
          permissionPolicy: true,
          hostId: true,
          effectiveTarget: true,
        },
      },
    },
  });
  if (!approval) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const now = new Date();
  const via = await decidingClient(req);
  // The stored decision is read through the serialiser so an unreadable value
  // narrows to `pending` the same way it does everywhere else. That is safe
  // here because the conditional update below, not this value, is what actually
  // decides whether the row may still be answered.
  const stored = serializeApproval(approval);

  const outcome = classifyApprovalDecision({
    submittedDecision: decision,
    submittedDigest: actionDigest,
    approval: {
      action: approval.action,
      detail: approval.detail,
      // Through the serialiser, so a risk column this build cannot read narrows
      // to `irreversible` — which is the fail-closed direction for the standing
      // allowance: an ungradeable action is one nothing may ever cover.
      risk: stored.risk,
      actionDigest: approval.actionDigest,
      policyDigest: approval.policyDigest,
      decision: stored.decision,
      expiresAt: approval.expiresAt,
    },
    policy: approval.run.permissionPolicy,
    now,
  });

  if (outcome.outcome === "refuse") {
    // Written before the response, and never allowed to fail it: the refusal
    // has already happened, and turning "Juno said no and wrote it down" into
    // "Juno crashed" helps nobody. `recordWorkAudit` swallows its own errors
    // for that reason.
    await recordWorkAudit({
      userId: user.id,
      kind: "approval_replay_refused",
      severity: "refusal",
      actor: via,
      sessionId: approval.run.sessionId,
      runId: approval.runId,
      detail: {
        approvalId: approval.id,
        action: approval.action,
        risk: approval.risk,
        actionDigest: approval.actionDigest,
        decision,
        reason: outcome.reason,
      },
    });
    // Only a request still pending: one closed when a later execution started
    // is not what the run waits on now, whatever else it is waiting for. And
    // only an attempt to allow it: bringing the run back to ask again is what
    // a person pressing Allow on a lapsed card wanted, and the opposite of
    // what one pressing Deny did. A deny leaves the run parked, and says so.
    const lapsedPending = outcome.reason === "expired" && approval.decision === "pending";
    const askingAgain =
      lapsedPending && decision !== "denied"
        ? await continueAfterRefusal(user.id, approval.id, approval.runId, now)
        : false;
    return NextResponse.json(
      {
        error: outcome.reason,
        message: refusalMessage(
          outcome.reason,
          approval.decision,
          askingAgain,
          lapsedPending && decision === "denied" && (await parkedOn(user.id, approval.id, approval.runId))
        ),
        ...(askingAgain ? { resumed: true } : {}),
      },
      { status: 409 }
    );
  }

  if (outcome.outcome === "replay") {
    // The decision is recorded already. A retry still puts a parked run back
    // in the queue, in case the first request was cut off before it did.
    const resumed = await continueAfterDecision(user.id, approval.id, approval.run, now);
    return NextResponse.json({ approval: stored, replay: true, ...resumed }, { status: 200 });
  }

  // `decision: "pending"` in the WHERE is what makes this write-once. Two
  // clients answering the same card at the same time — the phone that raised the
  // notification and the browser it was raised on — must not both succeed, or
  // the second one's answer silently replaces the first and the audit log
  // records the wrong person's decision.
  const recorded = await prisma.workApproval.updateMany({
    where: { id: approval.id, userId: user.id, decision: "pending" },
    data: { decision: outcome.decision, decidedAt: now, decidedVia: via },
  });

  if (recorded.count === 0) {
    const current = await prisma.workApproval.findFirst({ where: { id: approval.id, userId: user.id } });
    // Lost the race to an identical answer: the outcome the caller wanted is
    // the outcome that exists, so this is a replay rather than a conflict.
    if (current && serializeApproval(current).decision === outcome.decision) {
      const resumed = await continueAfterDecision(user.id, approval.id, approval.run, now);
      return NextResponse.json({ approval: serializeApproval(current), replay: true, ...resumed }, { status: 200 });
    }
    await recordWorkAudit({
      userId: user.id,
      kind: "approval_replay_refused",
      severity: "refusal",
      actor: via,
      sessionId: approval.run.sessionId,
      runId: approval.runId,
      detail: {
        approvalId: approval.id,
        action: approval.action,
        risk: approval.risk,
        actionDigest: approval.actionDigest,
        decision,
        reason: "already_decided" satisfies ApprovalDecisionRefusal,
      },
    });
    return NextResponse.json(
      { error: "already_decided", message: refusalMessage("already_decided", current?.decision ?? "", false) },
      { status: 409 }
    );
  }

  await recordWorkAudit({
    userId: user.id,
    kind: "approval_decided",
    actor: via,
    sessionId: approval.run.sessionId,
    runId: approval.runId,
    detail: {
      approvalId: approval.id,
      action: approval.action,
      risk: approval.risk,
      actionDigest: approval.actionDigest,
      policyDigest: approval.policyDigest,
      decision: outcome.decision,
    },
  });

  // The cloud executor learns the answer from the run's own event stream, keyed
  // on the approval so a retry of this request cannot append it twice.
  await appendEvents({
    runId: approval.runId,
    userId: user.id,
    events: [
      {
        kind: "approval_resolved",
        payload: {
          approvalId: approval.id,
          decision: outcome.decision,
          decidedVia: via,
          ...(reason ? { reason } : {}),
        },
        key: `approval:${approval.id}`,
      },
    ],
  });

  // A Mac does not read the event stream — it is the producer of it — so a
  // local run needs the answer as an instruction. `WorkApprovalCoordinator` is
  // holding the tool call open behind `approvals.resolve`, and without this the
  // person taps Allow on their phone and the Mac carries on waiting until the
  // approval's own TTL denies it.
  //
  // The digest travels with the decision because `LocalWorkExecutor` demands it
  // and refuses without one: it is what makes this an answer about an action
  // rather than about a sentence somebody read, so a decision that echoes a
  // different digest is refused by the coordinator instead of applied to
  // whatever happens to be waiting under that identifier.
  //
  // A refusal is not allowed to fail the request. The decision is already
  // written and audited above; reporting an error now would tell the client
  // their answer was not recorded when it was.
  const dispatched = await dispatchRunCommand({
    userId: user.id,
    sessionId: approval.run.sessionId,
    runId: approval.runId,
    hostId: approval.run.hostId,
    effectiveTarget: approval.run.effectiveTarget,
    // `allowed_always` sends `approve`, not a third kind. The difference
    // between "yes" and "yes, and stop asking" is a fact about this account's
    // future approvals and is remembered on this side; to the Mac holding one
    // tool call open, both are the same answer to the same question.
    kind: outcome.decision === "denied" ? "deny" : "approve",
    payload: {
      approvalId: approval.id,
      actionDigest: approval.actionDigest,
      ...(reason ? { reason } : {}),
    },
    // Keyed on the approval and the answer, not on the run: an approval is
    // decided once — `decision: "pending"` in the WHERE above sees to that — so
    // a retry that got this far resolves to the command already queued.
    idempotencyKey: approvalCommandKey(approval.id, outcome.decision),
  });
  if (dispatched.status === "refused") {
    await recordWorkAudit({
      userId: user.id,
      kind: dispatched.refusal.audit,
      severity: dispatched.refusal.severity,
      actor: "web",
      hostId: approval.run.hostId,
      sessionId: approval.run.sessionId,
      runId: approval.runId,
      detail: {
        approvalId: approval.id,
        commandKind: outcome.decision === "denied" ? "deny" : "approve",
        reason: dispatched.refusal.code,
      },
    });
  }

  // Answered, so the inbox stops asking too: the run's "needs your approval"
  // rows are read wherever the answer came from. Never allowed to fail the
  // request, for the same reason as the dispatch above.
  await markRunNotificationsRead(user.id, approval.runId, now).catch((markError: unknown) => {
    console.warn("[work-approval] could not clear the run's notifications", {
      runId: approval.runId,
      error: markError instanceof Error ? markError.message : String(markError),
    });
  });

  const resumed = await continueAfterDecision(user.id, approval.id, approval.run, now);

  const updated = await prisma.workApproval.findFirst({ where: { id: approval.id, userId: user.id } });
  return NextResponse.json({
    approval: updated ? serializeApproval(updated) : stored,
    // Null for a cloud run, which has no Mac to instruct, and for the Mac that
    // could not be told. Stated either way rather than omitted, so a client can
    // distinguish "recorded and delivered" from "recorded".
    command: dispatched.status === "queued" ? serializeCommand(dispatched.command) : null,
    ...resumed,
  });
}

/**
 * What happens to the run once its approval is decided.
 *
 * Read again now that the decision is written, never from the row read before
 * it: the executor may have parked in between (its wait ran out a moment
 * before the decision landed). It checks once more after it parks
 * (`parkedWaitAnswered`), so whichever of the two writes second sees the
 * other's.
 *
 * A cloud run the executor parked on this request goes back in the queue
 * (`requeueParkedRun`, a compare-and-set, so a retry, the answer route or a
 * press of Resume racing this changes nothing twice) and stays in "Needs you"
 * as resuming until it is picked up. When it resumes, the call it parked on is
 * given this decision — only for the same action digest, under the same
 * policy, before this approval's own expiry (src/lib/work/park-resume.ts) — so
 * the person decides once.
 *
 * Only for the request a cloud run is waiting on (`waitsOnApproval`): a
 * decision on an older one answers nothing the run will read, so it neither
 * requeues the run nor clears "Needs you" while what it does wait on is open.
 * Otherwise the session simply stops asking: the status belongs to the executor, which
 * moves the run off `waiting_approval` when it reads the decision, and a
 * status this build cannot read is left alone rather than mirrored as a guess.
 * A run the person paused stays paused, and one parked while no cloud worker
 * is alive keeps its place in "Needs you" so the person can resume it once one
 * is. A Mac run is answered over the relay and keeps the behaviour it had.
 */
async function continueAfterDecision(
  userId: string,
  approvalId: string,
  before: { id: string; sessionId: string; status: string; pauseReason: string | null; effectiveTarget: string | null },
  now: Date
): Promise<{ resumed: boolean; explanation?: string }> {
  const run = (await currentRunState({ runId: before.id, userId })) ?? before;
  if (run.effectiveTarget === "cloud" && !(await waitsOnApproval({ runId: run.id, userId, approvalId }))) {
    return { resumed: false };
  }
  const parked = run.status === "paused" && run.pauseReason === "waiting" && run.effectiveTarget === "cloud";
  if (parked) {
    // Nothing would pick it up: kept in "Needs you", and the person is told
    // what will carry it on, as the answer route tells them.
    if (!(await cloudWorkAvailable())) return { resumed: false, explanation: DECISION_KEPT_NO_EXECUTOR };
    const requeued = await requeueParkedRun({ runId: run.id, userId, now });
    return { resumed: requeued.requeued || (requeued.run !== null && requeued.run.status !== "paused" && !isTerminalStatus(requeued.run.status)) };
  }
  if (run.status === "paused" && run.effectiveTarget === "cloud") {
    // The person's own pause, on this request: theirs to lift. Nothing more is
    // asked of them now, and Resume hands the restored call this decision.
    await setSessionAttention({ sessionId: run.sessionId, userId, status: "paused", needsAttention: false, now });
    return { resumed: false, explanation: DECISION_KEPT_PAUSED };
  }
  if (isWorkStatus(run.status)) {
    await setSessionAttention({
      sessionId: run.sessionId,
      userId,
      status: run.status,
      needsAttention: false,
      now,
    });
  }
  return { resumed: run.status === "waiting_approval" || run.status === "queued" || run.status === "preparing" || run.status === "running" };
}

/**
 * After a refused attempt to allow an expired request: when the run is parked
 * on that very request, put it back in the queue so it asks again under a new
 * request with its own expiry. Nothing is authorised by this — the restored
 * call is told the request lapsed — and the expiry that refused the decision
 * is the stored one, unchanged. Returns whether the run is now asking again.
 * Never called for a deny: the person said no, and bringing the run back to
 * ask again would do the opposite (the run stays parked and they are told so).
 */
async function continueAfterRefusal(userId: string, approvalId: string, runId: string, now: Date): Promise<boolean> {
  if (!(await parkedOn(userId, approvalId, runId))) return false;
  if (!(await cloudWorkAvailable())) return false;
  const requeued = await requeueParkedRun({ runId, userId, now });
  return requeued.requeued;
}

/** Whether a cloud run is parked by its executor on this very request. */
async function parkedOn(userId: string, approvalId: string, runId: string): Promise<boolean> {
  const run = await currentRunState({ runId, userId });
  if (!run || run.status !== "paused" || run.pauseReason !== "waiting" || run.effectiveTarget !== "cloud") return false;
  return waitsOnApproval({ runId, userId, approvalId });
}

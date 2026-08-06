import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { isWorkStatus } from "@/lib/work/domain";
import { recordWorkAudit } from "@/lib/work/audit";
import { appendEvents, dispatchRunCommand, setSessionAttention } from "@/lib/work/store";
import { approvalCommandKey } from "@/lib/work/relay";
import { serializeApproval, serializeCommand } from "@/lib/work/serializers";
import {
  approvalDecisionSchema,
  classifyApprovalDecision,
  type ApprovalDecisionRefusal,
} from "@/app/api/work/protocol";

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
  policy_changed: "The permissions changed after you were asked. Juno will ask again.",
  expired: "This request expired before it was answered.",
  already_decided: "This request has already been answered.",
};

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
          permissionPolicy: true,
          hostId: true,
          effectiveTarget: true,
        },
      },
    },
  });
  if (!approval) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const now = new Date();
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
      actor: "web",
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
    return NextResponse.json(
      { error: outcome.reason, message: REFUSAL_MESSAGES[outcome.reason] },
      { status: 409 }
    );
  }

  if (outcome.outcome === "replay") {
    return NextResponse.json({ approval: stored, replay: true }, { status: 200 });
  }

  // `decision: "pending"` in the WHERE is what makes this write-once. Two
  // clients answering the same card at the same time — the phone that raised the
  // notification and the browser it was raised on — must not both succeed, or
  // the second one's answer silently replaces the first and the audit log
  // records the wrong person's decision.
  const recorded = await prisma.workApproval.updateMany({
    where: { id: approval.id, userId: user.id, decision: "pending" },
    data: { decision: outcome.decision, decidedAt: now, decidedVia: "web" },
  });

  if (recorded.count === 0) {
    const current = await prisma.workApproval.findFirst({ where: { id: approval.id, userId: user.id } });
    // Lost the race to an identical answer: the outcome the caller wanted is
    // the outcome that exists, so this is a replay rather than a conflict.
    if (current && serializeApproval(current).decision === outcome.decision) {
      return NextResponse.json({ approval: serializeApproval(current), replay: true }, { status: 200 });
    }
    await recordWorkAudit({
      userId: user.id,
      kind: "approval_replay_refused",
      severity: "refusal",
      actor: "web",
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
      { error: "already_decided", message: REFUSAL_MESSAGES.already_decided },
      { status: 409 }
    );
  }

  await recordWorkAudit({
    userId: user.id,
    kind: "approval_decided",
    actor: "web",
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
          decidedVia: "web",
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

  // The question has been answered, so the session stops asking. The status
  // itself belongs to the executor — it moves the run off `waiting_approval`
  // when it picks the decision up — and a status this build cannot read is left
  // alone rather than mirrored as a guess.
  if (isWorkStatus(approval.run.status)) {
    await setSessionAttention({
      sessionId: approval.run.sessionId,
      userId: user.id,
      status: approval.run.status,
      needsAttention: false,
      now,
    });
  }

  const updated = await prisma.workApproval.findFirst({ where: { id: approval.id, userId: user.id } });
  return NextResponse.json({
    approval: updated ? serializeApproval(updated) : stored,
    // Null for a cloud run, which has no Mac to instruct, and for the Mac that
    // could not be told. Stated either way rather than omitted, so a client can
    // distinguish "recorded and delivered" from "recorded".
    command: dispatched.status === "queued" ? serializeCommand(dispatched.command) : null,
  });
}

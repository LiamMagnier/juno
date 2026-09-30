import "server-only";

/**
 * Transferring a task between crew members, on the server.
 *
 * The rule is `ownerTransferRefusal` (src/lib/work/ownership.ts); this file is
 * the one place that applies it. Everything is written in one transaction and
 * guarded by compare-and-set on the owner and the status, so two transfers
 * racing for the same task leave exactly one winner and a transfer that lost
 * the race to a dispatch (the task moved past its safe point between the read
 * and the write) changes nothing.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { WORK_TERMINAL_STATUSES, type WorkPermissionPolicy } from "@/lib/work/domain";
import {
  MAX_TRANSFER_REASON_CHARS,
  ownerTransferRefusal,
  ownerTransferSentence,
  ownerTransferredPayload,
  transferredConnectorIds,
  transferredPermissionPolicy,
  type OwnerTransferRefusalCode,
} from "@/lib/work/ownership";
import { agentApprovalMode } from "@/lib/agents/domain";

export type TransferActor = { kind: "person" } | { kind: "member"; agentId: string };

export type TransferOutcome =
  | {
      ok: true;
      sessionId: string;
      fromAgentId: string | null;
      toAgentId: string | null;
      summary: string;
    }
  | {
      ok: false;
      status: number;
      code: OwnerTransferRefusalCode | "not_found" | "member_not_found" | "conflict";
      message: string;
    };

const SAFE_STATUSES = ["draft", "paused", "queued", ...WORK_TERMINAL_STATUSES] as const;

function policyOf(value: string): WorkPermissionPolicy {
  return value === "conservative" || value === "permissive" ? value : "balanced";
}

/**
 * Hands a task to another crew member, or back to the person (`toAgentId:
 * null`).
 *
 * Narrows, never widens: the task keeps the stricter of its own approval mode
 * and the new owner's, and only the apps the new owner may use. The move is
 * recorded as an `owner_transferred` event on the task's latest attempt (when
 * it has one) and in both members' logs.
 */
export async function transferWorkSessionOwner(input: {
  userId: string;
  sessionId: string;
  toAgentId: string | null;
  reason: string;
  by: TransferActor;
  now?: Date;
}): Promise<TransferOutcome> {
  const now = input.now ?? new Date();
  const reason = input.reason.trim().slice(0, MAX_TRANSFER_REASON_CHARS);
  const session = await prisma.workSession.findFirst({
    where: { id: input.sessionId, userId: input.userId, deletedAt: null },
    select: {
      id: true,
      agentId: true,
      status: true,
      permissionPolicy: true,
      connectors: { select: { connectorId: true } },
    },
  });
  if (!session) return { ok: false, status: 404, code: "not_found", message: "That task no longer exists." };

  const memberIds = [session.agentId, input.toAgentId, input.by.kind === "member" ? input.by.agentId : null].filter(
    (id): id is string => typeof id === "string"
  );
  const members = memberIds.length
    ? await prisma.agent.findMany({
        where: { userId: input.userId, id: { in: memberIds } },
        select: { id: true, name: true, status: true, approvalMode: true, connectorIds: true, deletedAt: true },
      })
    : [];
  const byId = new Map(members.map((member) => [member.id, member]));
  const target = input.toAgentId ? byId.get(input.toAgentId) : null;
  if (input.toAgentId && (!target || target.deletedAt)) {
    return { ok: false, status: 404, code: "member_not_found", message: "That crew member no longer exists." };
  }
  if (input.by.kind === "member" && !byId.get(input.by.agentId)) {
    return { ok: false, status: 404, code: "member_not_found", message: "That crew member no longer exists." };
  }
  const from = session.agentId ? byId.get(session.agentId) ?? null : null;

  const run = await prisma.workRun.findFirst({
    where: { sessionId: session.id, userId: input.userId },
    orderBy: { attempt: "desc" },
    select: { id: true, status: true, claimedBy: true, leaseExpiresAt: true },
  });

  const refusal = ownerTransferRefusal({
    status: session.status,
    fromAgentId: session.agentId,
    toAgentId: input.toAgentId,
    toAgentStatus: target?.status ?? null,
    fromName: from?.name ?? null,
    toName: target?.name ?? null,
    run,
    reason,
    now,
  });
  if (refusal) {
    return { ok: false, status: refusal.code === "reason_required" ? 400 : 409, code: refusal.code, message: refusal.message };
  }

  const nextPolicy = transferredPermissionPolicy({
    current: policyOf(session.permissionPolicy),
    toMemberMode: target ? agentApprovalMode(target.approvalMode) : null,
  });
  const keep = new Set(
    transferredConnectorIds({
      current: session.connectors.map((row) => row.connectorId),
      toMemberConnectorIds: target ? target.connectorIds : null,
    })
  );
  const dropped = session.connectors.map((row) => row.connectorId).filter((id) => !keep.has(id));
  const actor =
    input.by.kind === "person"
      ? ({ kind: "person" } as const)
      : ({ kind: "member", agentId: input.by.agentId, name: byId.get(input.by.agentId)?.name ?? null } as const);
  const sides = {
    from: { agentId: session.agentId, name: from?.name ?? null },
    to: { agentId: input.toAgentId, name: target?.name ?? null },
  };
  const payload = ownerTransferredPayload({ ...sides, by: actor, reason, at: now });
  const summary = ownerTransferSentence({ ...sides, by: actor, reason });

  const moved = await prisma.$transaction(async (tx) => {
    // Compare-and-set on the owner AND a safe status. A dispatch or another
    // transfer that landed since the read above makes this a no-op.
    const updated = await tx.workSession.updateMany({
      where: {
        id: session.id,
        userId: input.userId,
        deletedAt: null,
        agentId: session.agentId,
        status: { in: [...SAFE_STATUSES] },
      },
      data: {
        agentId: input.toAgentId,
        ownerTransferredAt: now,
        permissionPolicy: nextPolicy,
      },
    });
    if (updated.count !== 1) return false;
    // The run's lease is re-checked inside the transaction: a queued attempt
    // claimed between the read and here is past its safe point.
    if (run && session.status === "queued") {
      const claimed = await tx.workRun.count({
        where: { id: run.id, userId: input.userId, claimedBy: { not: null }, leaseExpiresAt: { gt: now } },
      });
      if (claimed > 0) throw new TransferRaced();
    }
    if (dropped.length > 0) {
      await tx.workSessionConnector.deleteMany({
        where: { sessionId: session.id, userId: input.userId, connectorId: { in: dropped } },
      });
    }
    if (run) {
      const bumped = await tx.workRun.update({
        where: { id: run.id, userId: input.userId },
        data: { lastSeq: { increment: 1 } },
        select: { lastSeq: true },
      });
      await tx.workEvent.create({
        data: {
          runId: run.id,
          userId: input.userId,
          seq: bumped.lastSeq,
          kind: "owner_transferred",
          visibility: "user",
          payload: payload as Prisma.InputJsonValue,
          eventKey: `owner-transfer:${session.id}:${now.getTime()}`,
        },
      });
    }
    return true;
  }).catch((err) => {
    if (err instanceof TransferRaced) return false;
    throw err;
  });
  if (!moved) {
    return {
      ok: false,
      status: 409,
      code: "not_at_safe_point",
      message: "This task changed while it was being handed over. Look at it again, then try once more.",
    };
  }

  const { recordAgentEvent } = await import("@/lib/agents/store");
  await Promise.all([
    session.agentId
      ? recordAgentEvent({
          userId: input.userId,
          agentId: session.agentId,
          kind: "task_transferred",
          title: summary,
          sessionId: session.id,
          detail: { direction: "out", toAgentId: input.toAgentId, reason },
        })
      : null,
    input.toAgentId
      ? recordAgentEvent({
          userId: input.userId,
          agentId: input.toAgentId,
          kind: "task_transferred",
          title: summary,
          sessionId: session.id,
          detail: { direction: "in", fromAgentId: session.agentId, reason },
        })
      : null,
  ]);

  return { ok: true, sessionId: session.id, fromAgentId: session.agentId, toAgentId: input.toAgentId, summary };
}

class TransferRaced extends Error {
  constructor() {
    super("transfer raced a claim");
  }
}

import { NextResponse } from "next/server";
import type { WorkHost } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { narrowestPolicy } from "@/lib/work/domain";
import { recordWorkAudit } from "@/lib/work/audit";
import { serializeGrant, serializeHost } from "@/lib/work/serializers";
import { effectiveHostState } from "@/app/api/work/protocol";
import {
  HOST_NOT_FOUND,
  WORK_RELAY_REFUSALS,
  advertisedCapabilityKeys,
  hostPatchSchema,
  isPermissionPolicy,
  narrowHostToggles,
  parseAdvertisement,
  refusalBody,
  type HostToggles,
} from "@/lib/work/relay";

export const runtime = "nodejs";

type RouteParams = { params: Promise<{ id: string }> };

function togglesOf(host: Pick<WorkHost, keyof HostToggles>): HostToggles {
  return {
    enabled: host.enabled,
    allowsFileWork: host.allowsFileWork,
    allowsBrowser: host.allowsBrowser,
    allowsComputerUse: host.allowsComputerUse,
    allowsShell: host.allowsShell,
    allowsBackground: host.allowsBackground,
  };
}

/**
 * One Mac, with what it has been given access to.
 *
 * The grants are serialised through `serializeGrant`, which is bound to the
 * pathless half. This is the screen where a phone shows "Downloads" and
 * "Quarterly reports", and it must be able to do that without ever holding
 * /Users/liam/Downloads: a path here is a path in a screenshot, in a support
 * ticket, and in the next prompt-injection payload that asks the agent to read
 * something next to it.
 */
export async function GET(_req: Request, { params }: RouteParams) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const host = await prisma.workHost.findFirst({ where: { id, userId: user.id } });
  if (!host) return NextResponse.json(HOST_NOT_FOUND, { status: 404 });

  const now = new Date();
  const [grants, pendingCommands] = await Promise.all([
    prisma.workFileGrant.findMany({
      where: { hostId: host.id, userId: user.id, revokedAt: null },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    prisma.workCommand.count({
      where: {
        hostId: host.id,
        userId: user.id,
        status: { in: ["pending", "claimed"] },
        expiresAt: { gt: now },
      },
    }),
  ]);

  return NextResponse.json({
    // The stored state is narrowed by the heartbeat, the same way the list
    // route does it: `online` left behind on a row by a Mac that was closed an
    // hour ago is exactly what makes a user wait for work nobody will claim.
    host: serializeHost({ ...host, state: effectiveHostState(host, now) }),
    grants: grants.map(serializeGrant),
    pendingCommands,
    routableCapabilities: advertisedCapabilityKeys(host.capabilities),
  });
}

/**
 * The owner changes what one Mac may do.
 *
 * Switching a capability *off* always works, from anywhere, immediately.
 * Switching one *on* requires the Mac to have advertised it — the ceiling is
 * the host's own last advertisement, not whatever the request asks for. That
 * asymmetry is the escalation boundary of the relay: the alternative is a
 * stolen web session granting shell access to a machine whose owner never
 * offered it, and the owner is the one person in the system standing in front
 * of that machine.
 */
export async function PATCH(req: Request, { params }: RouteParams) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const parsed = hostPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const patch = parsed.data;

  const host = await prisma.workHost.findFirst({ where: { id, userId: user.id } });
  if (!host) return NextResponse.json(HOST_NOT_FOUND, { status: 404 });

  const restoring = patch.revoked === false;
  // A revoked host is inert until it is explicitly restored. Accepting a toggle
  // change against it would leave a Mac that is switched on in the settings
  // screen and refused by every relay endpoint, which is a state nobody can
  // reason about from either end.
  if (host.revokedAt && !restoring) {
    await recordWorkAudit({
      userId: user.id,
      kind: WORK_RELAY_REFUSALS.revoked.audit,
      severity: WORK_RELAY_REFUSALS.revoked.severity,
      actor: "web",
      hostId: host.id,
      detail: { hostId: host.id, reason: "patch", revoked: true },
    });
    return NextResponse.json(refusalBody(WORK_RELAY_REFUSALS.revoked), {
      status: WORK_RELAY_REFUSALS.revoked.status,
    });
  }

  // The ceiling. A row with no readable manifest — written before this shape
  // existed, or truncated — falls back to what is currently in force, so the
  // patch can still narrow but cannot widen against evidence that is missing.
  const advertisement = parseAdvertisement(host.capabilities);
  const current = togglesOf(host);
  const ceiling = advertisement?.toggles ?? current;
  const outcome = narrowHostToggles(ceiling, current, patch);

  const currentPolicy = isPermissionPolicy(host.approvalPolicy) ? host.approvalPolicy : "conservative";
  // Same rule in three values: the owner may pick any policy at least as strict
  // as the one the Mac advertised, and asking for a looser one lands on the
  // Mac's. `narrowestPolicy` is the meet, so this cannot widen by construction.
  const requestedPolicy = patch.approvalPolicy ?? currentPolicy;
  const approvalPolicy = narrowestPolicy(
    requestedPolicy,
    advertisement?.approvalPolicy ?? currentPolicy
  );

  const updated = await prisma.workHost.update({
    where: { id: host.id, userId: user.id },
    data: {
      ...outcome.applied,
      approvalPolicy,
      ...(restoring ? { revokedAt: null } : {}),
    },
  });

  if (restoring && host.revokedAt) {
    await recordWorkAudit({
      userId: user.id,
      kind: "host_enabled",
      severity: "warning",
      actor: "web",
      hostId: host.id,
      detail: { hostId: host.id, deviceId: host.deviceId, revoked: false, enabled: updated.enabled },
    });
  } else if (host.enabled !== updated.enabled) {
    await recordWorkAudit({
      userId: user.id,
      kind: updated.enabled ? "host_enabled" : "host_disabled",
      severity: "info",
      actor: "web",
      hostId: host.id,
      detail: { hostId: host.id, deviceId: host.deviceId, enabled: updated.enabled },
    });
  }

  if (outcome.refused.length > 0) {
    // `policy_narrowed` rather than `command_refused`: nothing was commanded.
    // What happened is that a request to widen was met with the host's own
    // ceiling, and that is the question this kind answers.
    await recordWorkAudit({
      userId: user.id,
      kind: "policy_narrowed",
      severity: "refusal",
      actor: "web",
      hostId: host.id,
      detail: { hostId: host.id, refused: outcome.refused, policy: approvalPolicy },
    });
  }

  return NextResponse.json({
    host: serializeHost({ ...updated, state: effectiveHostState(updated, new Date()) }),
    // Named rather than silently dropped. A settings screen showing a toggle
    // snap back with no explanation is a bug report; "that Mac has not offered
    // this" is a sentence the client can render.
    refused: outcome.refused,
  });
}

/**
 * The owner revokes a Mac.
 *
 * Two writes, and the second is what makes revocation immediate rather than
 * eventual. Setting `revokedAt` stops the next claim — the long poll re-reads
 * it on every pass — but a command already sitting in the queue would still be
 * waiting for a host that is never coming back, so the queue is retired with
 * it. Without that, the phone that issued a "stop" watches it stay pending for
 * five minutes and then expire, with nothing saying why.
 *
 * Idempotent: revoking an already-revoked host is the same answer, not an
 * error. A client retrying this over a bad connection is doing the right thing.
 */
export async function DELETE(_req: Request, { params }: RouteParams) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const host = await prisma.workHost.findFirst({ where: { id, userId: user.id } });
  if (!host) return NextResponse.json(HOST_NOT_FOUND, { status: 404 });

  if (host.revokedAt) {
    return NextResponse.json({
      host: serializeHost({ ...host, state: effectiveHostState(host, new Date()) }),
      cancelledCommands: 0,
    });
  }

  const now = new Date();
  const revoked = await prisma.workHost.update({
    where: { id: host.id, userId: user.id },
    data: {
      revokedAt: now,
      // Both, not just the timestamp. `enabled` is the flag every other reader
      // consults, and leaving it true would show a revoked Mac as switched on
      // everywhere the revocation timestamp is not also checked.
      enabled: false,
      state: "offline",
    },
  });

  const cancelled = await prisma.workCommand.updateMany({
    where: {
      hostId: host.id,
      userId: user.id,
      status: { in: ["pending", "claimed"] },
    },
    data: { status: "cancelled", completedAt: now, leaseExpiresAt: null },
  });

  await recordWorkAudit({
    userId: user.id,
    kind: "host_revoked",
    severity: "warning",
    actor: "web",
    hostId: host.id,
    detail: {
      hostId: host.id,
      deviceId: host.deviceId,
      revoked: true,
      count: cancelled.count,
      capabilities: advertisedCapabilityKeys(host.capabilities),
    },
  });

  return NextResponse.json({
    host: serializeHost({ ...revoked, state: effectiveHostState(revoked, now) }),
    cancelledCommands: cancelled.count,
  });
}

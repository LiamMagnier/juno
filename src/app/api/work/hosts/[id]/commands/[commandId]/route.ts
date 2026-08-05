import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { recordWorkAudit } from "@/lib/work/audit";
import { serializeCommand } from "@/lib/work/serializers";
import {
  HOST_NOT_FOUND,
  WORK_RELAY_REFUSALS,
  commandAckSchema,
  refusalBody,
  refuseHostPlane,
  type WorkRelayRefusal,
} from "@/lib/work/relay";

export const runtime = "nodejs";

type RouteParams = { params: Promise<{ id: string; commandId: string }> };

async function refuse(
  refusal: WorkRelayRefusal,
  audit: { userId: string; hostId: string; sessionId?: string | null; detail: Record<string, unknown> }
): Promise<NextResponse> {
  await recordWorkAudit({
    userId: audit.userId,
    kind: refusal.audit,
    severity: refusal.severity,
    actor: "macos",
    hostId: audit.hostId,
    sessionId: audit.sessionId ?? null,
    detail: { ...audit.detail, reason: refusal.code },
  });
  return NextResponse.json(refusalBody(refusal), { status: refusal.status });
}

/**
 * The host reports what happened to one command.
 *
 * Every claimed command gets one of these, including the ones that failed and
 * the ones the Mac refused on its own policy. `WorkRemoteHost.handle`
 * acknowledges a failure precisely because the alternative strands it: the
 * lease holds, no other process may take it, and the command neither completes
 * nor fails. That presents to the user as a task that is starting forever.
 *
 * The transition is a conditional `updateMany` for the same reason the claim is
 * — the row may have expired or been cancelled while the host was working, and
 * a blind write would resurrect an instruction the relay had already retired.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id, commandId } = await params;

  const host = await prisma.workHost.findFirst({
    where: { id, userId: user.id },
    select: { id: true, enabled: true, revokedAt: true },
  });
  if (!host) return NextResponse.json(HOST_NOT_FOUND, { status: 404 });

  // Disabled is allowed through here and nowhere else. The user switching Work
  // off must not strand an instruction the Mac is already carrying out with no
  // outcome, because the phone that issued it would show it as still running.
  // Revocation is refused even here: it is a security action, and a revoked Mac
  // has to stop talking to the relay altogether.
  const gate = refuseHostPlane(host, { allowDisabled: true });
  if (gate) {
    return await refuse(gate, {
      userId: user.id,
      hostId: host.id,
      detail: { hostId: host.id, commandId },
    });
  }

  const parsed = commandAckSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const body = parsed.data;

  const now = new Date();
  const settled = await prisma.workCommand.updateMany({
    where: { id: commandId, userId: user.id, hostId: host.id, status: "claimed" },
    data: {
      status: body.status,
      result: (body.result ?? undefined) as Prisma.InputJsonObject | undefined,
      error: body.error,
      completedAt: now,
      // Released explicitly. A settled command with a lease still on it reads
      // as claimed-and-running to anything scanning for stalled work.
      leaseExpiresAt: null,
    },
  });

  if (!settled.count) {
    const existing = await prisma.workCommand.findFirst({
      where: { id: commandId, userId: user.id, hostId: host.id },
    });
    if (!existing) return NextResponse.json(HOST_NOT_FOUND, { status: 404 });

    // The host acknowledged, the response was lost, and it acknowledged again.
    // Replaying the same verdict is safe and is the expected shape of a retry;
    // replaying a *different* one is not, because the first answer is already
    // what the user was shown.
    if (existing.status === body.status) {
      return NextResponse.json({ command: serializeCommand(existing), replay: true });
    }

    const refusal =
      existing.status === "expired"
        ? WORK_RELAY_REFUSALS.commandExpired
        : WORK_RELAY_REFUSALS.commandConflict;
    return await refuse(refusal, {
      userId: user.id,
      hostId: host.id,
      sessionId: existing.sessionId,
      detail: {
        hostId: host.id,
        commandId: existing.id,
        commandKind: existing.kind,
        outcome: existing.status,
        decision: body.status,
      },
    });
  }

  const command = await prisma.workCommand.findFirst({
    where: { id: commandId, userId: user.id },
  });
  if (!command) return NextResponse.json(HOST_NOT_FOUND, { status: 404 });

  // `serializeCommand` is the filtered half, and it is load-bearing on this
  // response rather than merely tidy. A `grant_folder` acknowledgement carries
  // the absolute path the user picked in the file dialog, and this body travels
  // back to whichever client is watching the command — which is the phone the
  // whole grant design keeps that path from.
  return NextResponse.json({ command: serializeCommand(command) });
}

import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { recordWorkAudit } from "@/lib/work/audit";
import { appendEvents, type WorkEventInput } from "@/lib/work/store";
import {
  HOST_NOT_FOUND,
  hostOutboxSchema,
  planHostOutbox,
  refusalBody,
  refuseHostPlane,
} from "@/lib/work/relay";

export const runtime = "nodejs";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * Where a Mac's outbox drains.
 *
 * The host buffers its own events and posts them in batches, because the
 * alternative — one request per event — loses the transcript the moment the
 * network does. Everything difficult about that arrangement is on this side:
 * the batch may arrive twice, out of order, or with a hole in the middle where
 * a write to the host's own buffer failed.
 *
 * Duplicates are settled twice over, deliberately. `planHostOutbox` drops the
 * ones it can see so a re-delivery does not consume a producer sequence and
 * leave a phantom gap behind it, and `appendEvents` arbitrates against the
 * database inside its transaction, which is the only place that can be
 * authoritative when two batches are in flight at once.
 *
 * A hole truncates the batch rather than rejecting it. A Mac reconnecting after
 * an hour offline presents thousands of events; refusing all of them because
 * one is missing throws away everything that did arrive, and the re-send has
 * the same hole in it. The response names the missing sequence, which is the
 * one request that can make progress.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const host = await prisma.workHost.findFirst({
    where: { id, userId: user.id },
    select: { id: true, enabled: true, revokedAt: true },
  });
  if (!host) return NextResponse.json(HOST_NOT_FOUND, { status: 404 });

  // A disabled host may still drain. These events have already happened — they
  // are the record of what the Mac did before the switch was thrown — and
  // dropping them would delete the last minute of the user's own transcript as
  // a side effect of pausing Work. Revocation still refuses.
  const gate = refuseHostPlane(host, { allowDisabled: true });
  if (gate) {
    await recordWorkAudit({
      userId: user.id,
      kind: gate.audit,
      severity: gate.severity,
      actor: "macos",
      hostId: host.id,
      detail: { hostId: host.id, reason: gate.code },
    });
    return NextResponse.json(refusalBody(gate), { status: gate.status });
  }

  const parsed = hostOutboxSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const body = parsed.data;

  // The run is bound to this account AND to this host. Without the second half,
  // a Mac could append to a run executing on the user's other Mac, and the
  // transcript would interleave two machines' work with no way to tell them
  // apart afterwards.
  const run = await prisma.workRun.findFirst({
    where: { id: body.runId, userId: user.id, hostId: host.id },
    select: { id: true, lastSeq: true, sessionId: true },
  });
  if (!run) return NextResponse.json(HOST_NOT_FOUND, { status: 404 });

  const keys = body.events
    .map((event) => event.eventKey)
    .filter((key): key is string => typeof key === "string" && key.length > 0);
  const stored = keys.length
    ? await prisma.workEvent.findMany({
        where: { runId: run.id, userId: user.id, eventKey: { in: keys } },
        select: { eventKey: true },
      })
    : [];
  const seenKeys = new Set(
    stored.map((row) => row.eventKey).filter((key): key is string => key !== null)
  );

  const plan = planHostOutbox({ acknowledgedSeq: body.afterSeq, events: body.events, seenKeys });

  const appended = plan.accepted.length
    ? await appendEvents({
        runId: run.id,
        userId: user.id,
        events: plan.accepted.map(
          (event): WorkEventInput => ({
            kind: event.kind,
            payload: event.payload as Prisma.InputJsonObject,
            key: event.eventKey ?? null,
            payloadVersion: event.payloadVersion,
            // Left unset when the host does not classify it, so the per-kind
            // table in `domain.ts` decides. A host asserting `user` on a kind
            // that is internal would put executor detail in the transcript.
            visibility: event.visibility,
            agentId: event.agentId ?? null,
          })
        ),
      })
    : null;

  return NextResponse.json({
    /** The relay's own cursor, which is what clients resume the stream from. */
    lastSeq: appended?.lastSeq ?? run.lastSeq,
    /** The producer cursor, echoed so the host's next `afterSeq` agrees. */
    acceptedThrough: plan.acceptedThrough,
    accepted: appended?.appended.length ?? 0,
    // Both halves: what the plan recognised as a re-delivery, and what the
    // append found already stored. Summed rather than reported separately
    // because to the host they are one fact — how much of that batch was
    // already here.
    duplicates: plan.duplicates.length + (appended?.duplicates ?? 0),
    /** Non-null means: re-send from here. */
    firstGap: plan.firstGap,
  });
}

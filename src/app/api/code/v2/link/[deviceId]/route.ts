import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { ONLINE_WINDOW_MS, requireUser } from "@/lib/code-remote";
import {
  LINK_SESSION_ID,
  POLL_WAIT_MS,
  RPC_WAIT_MS,
  linkCommandRow,
  offlineReply,
  parseLinkRequest,
  shapeReply,
} from "@/lib/code-v2/device-link";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Hosted web → the user's Mac env server (Alevr Code v2, SPEC §3.1). The
 * browser's `DeviceLinkTransport` posts wire commands and long-polls events by
 * cursor here; the Mac's existing command long-poll claims them and acks with
 * the env server's answer. See src/lib/code-v2/device-link.ts for the host
 * contract. Replaces the 1.2 s task poll for sessions on a linked Mac.
 */
export async function POST(req: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { deviceId } = await params;
  const device = await prisma.codeDevice.findFirst({ where: { id: deviceId, userId: user.id }, select: { id: true, name: true, lastSeenAt: true } });
  if (!device) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = parseLinkRequest(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  if (Date.now() - device.lastSeenAt.getTime() > ONLINE_WINDOW_MS) return NextResponse.json(offlineReply(device.name));

  const remote =
    (await prisma.codeRemoteSession.findUnique({
      where: { deviceId_sessionId: { deviceId, sessionId: LINK_SESSION_ID }, userId: user.id },
      select: { id: true },
    })) ??
    (await prisma.codeRemoteSession.create({
      data: {
        userId: user.id,
        deviceId,
        sessionId: LINK_SESSION_ID,
        title: "Alevr Code link",
        modelId: "default",
        createdAt: new Date(),
        sessionUpdatedAt: new Date(),
        lastMessageAt: new Date(),
      },
      select: { id: true },
    }));

  const row = linkCommandRow(parsed.request, randomUUID());
  const command = await prisma.codeSessionCommand.create({
    data: {
      userId: user.id,
      deviceId,
      remoteSessionId: remote.id,
      sessionId: LINK_SESSION_ID,
      kind: row.kind,
      payload: row.payload as Prisma.InputJsonValue,
      idempotencyKey: row.idempotencyKey,
      status: "pending",
    },
    select: { id: true },
  });

  const deadline = Date.now() + (parsed.request.kind === "rpc" ? RPC_WAIT_MS : POLL_WAIT_MS);
  for (;;) {
    if (req.signal.aborted) break;
    const done = await prisma.codeSessionCommand.findFirst({
      where: { id: command.id, userId: user.id, status: { in: ["completed", "failed"] } },
      select: { status: true, result: true, error: true },
    });
    if (done) {
      // A failed relay command means this Mac cannot serve the link (an older app): back off as offline.
      if (done.status === "failed") return NextResponse.json({ ...shapeReply(done.result), ...offlineReply(device.name), message: done.error ?? offlineReply(device.name).message });
      return NextResponse.json(shapeReply(done.result));
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  // Nobody answered: withdraw the command so a Mac that wakes later does not run a stale one.
  await prisma.codeSessionCommand.updateMany({ where: { id: command.id, userId: user.id, status: "pending" }, data: { status: "failed", error: "expired", completedAt: new Date() } });
  // An unanswered poll is an empty poll, not an outage; an unanswered rpc is.
  return NextResponse.json(parsed.request.kind === "poll" ? {} : offlineReply(device.name));
}

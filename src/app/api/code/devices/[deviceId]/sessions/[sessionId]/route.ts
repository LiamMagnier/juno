import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { sessionCommandRateLimit } from "@/lib/code-session-command-route";
import {
  TRANSCRIPT_POLICIES,
  deviceIsOnline,
  policyKeepsContent,
  serializeRemoteSessionDetail,
  snapshotIsStale,
} from "@/lib/code-remote-sessions";

export const runtime = "nodejs";
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const snapshotSchema = z.object({
  snapshotVersion: z.number().int().min(1),
  transcriptVersion: z.number().int().min(1),
  transcriptPolicy: z.enum(TRANSCRIPT_POLICIES),
  transcript: z.unknown().nullable().optional(),
  changes: z.unknown().nullable().optional(),
  terminal: z.unknown().nullable().optional(),
  tests: z.unknown().nullable().optional(),
  git: z.unknown().nullable().optional(),
  approvals: z.unknown().nullable().optional(),
  subagents: z.unknown().nullable().optional(),
  usage: z.unknown().nullable().optional(),
  lastEventSequence: z.number().int().min(0),
});

const patchSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  expectedVersion: z.number().int().min(1).optional(),
  idempotencyKey: z.string().min(8).max(200),
}).refine((value) => value.title !== undefined || value.pinned !== undefined || value.archived !== undefined, "empty_patch");

async function ownedSession(deviceId: string, sessionId: string, userId: string) {
  return prisma.codeRemoteSession.findFirst({
    where: { deviceId, sessionId, userId, deletedAt: null },
    include: { device: true },
  });
}

export async function GET(_req: Request, { params }: { params: Promise<{ deviceId: string; sessionId: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { deviceId, sessionId } = await params;
  const session = await ownedSession(deviceId, sessionId, user.id);
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  return NextResponse.json(serializeRemoteSessionDetail(session, deviceIsOnline(session.device.lastSeenAt)));
}

/// Host uploads the authoritative detail snapshot only when the configured
/// transcript policy allows it. A metadata policy forcibly strips local content.
export async function PUT(req: Request, { params }: { params: Promise<{ deviceId: string; sessionId: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { deviceId, sessionId } = await params;
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  const parsed = snapshotSchema.safeParse(JSON.parse(raw || "null"));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const session = await ownedSession(deviceId, sessionId, user.id);
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  if (snapshotIsStale(parsed.data, session)) {
    return NextResponse.json({ error: "stale_snapshot", currentVersion: session.snapshotVersion }, { status: 409 });
  }
  const keepContent = policyKeepsContent(parsed.data.transcriptPolicy);
  const data = {
    snapshotVersion: parsed.data.snapshotVersion,
    transcriptVersion: parsed.data.transcriptVersion,
    transcriptPolicy: parsed.data.transcriptPolicy,
    transcript: keepContent ? (parsed.data.transcript as Prisma.InputJsonValue ?? undefined) : Prisma.JsonNull,
    changes: keepContent ? (parsed.data.changes as Prisma.InputJsonValue ?? undefined) : Prisma.JsonNull,
    terminal: keepContent ? (parsed.data.terminal as Prisma.InputJsonValue ?? undefined) : Prisma.JsonNull,
    tests: keepContent ? (parsed.data.tests as Prisma.InputJsonValue ?? undefined) : Prisma.JsonNull,
    git: keepContent ? (parsed.data.git as Prisma.InputJsonValue ?? undefined) : Prisma.JsonNull,
    approvals: keepContent ? (parsed.data.approvals as Prisma.InputJsonValue ?? undefined) : Prisma.JsonNull,
    subagents: keepContent ? (parsed.data.subagents as Prisma.InputJsonValue ?? undefined) : Prisma.JsonNull,
    usage: keepContent ? (parsed.data.usage as Prisma.InputJsonValue ?? undefined) : Prisma.JsonNull,
    lastEventSequence: parsed.data.lastEventSequence,
    syncedAt: new Date(),
  };
  await prisma.codeRemoteSession.update({ where: { id: session.id }, data });
  return NextResponse.json({ ok: true, snapshotVersion: parsed.data.snapshotVersion });
}

async function enqueueMutation(
  req: Request,
  params: Promise<{ deviceId: string; sessionId: string }>,
  kind: "patch" | "delete",
) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const limited = await sessionCommandRateLimit(user.id);
  if (limited) return limited;
  const { deviceId, sessionId } = await params;
  const session = await ownedSession(deviceId, sessionId, user.id);
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  if (parsed.data.expectedVersion && parsed.data.expectedVersion !== session.snapshotVersion) {
    return NextResponse.json({ error: "version_conflict", currentVersion: session.snapshotVersion }, { status: 409 });
  }
  const payload = kind === "delete"
    ? { confirmation: true, expectedVersion: parsed.data.expectedVersion }
    : { title: parsed.data.title, pinned: parsed.data.pinned, archived: parsed.data.archived, expectedVersion: parsed.data.expectedVersion };
  const command = await prisma.codeSessionCommand.upsert({
    where: { userId_idempotencyKey: { userId: user.id, idempotencyKey: parsed.data.idempotencyKey } },
    create: { userId: user.id, deviceId, remoteSessionId: session.id, sessionId, kind, payload, idempotencyKey: parsed.data.idempotencyKey },
    update: {},
  });
  return NextResponse.json({ commandId: command.id, status: command.status }, { status: command.status === "pending" ? 202 : 200 });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ deviceId: string; sessionId: string }> }) {
  return enqueueMutation(req, params, "patch");
}

export async function DELETE(req: Request, { params }: { params: Promise<{ deviceId: string; sessionId: string }> }) {
  return enqueueMutation(req, params, "delete");
}

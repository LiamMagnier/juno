import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import {
  TRANSCRIPT_POLICIES,
  SESSION_STATUSES,
  decodeCursor,
  deviceIsOnline,
  encodeCursor,
  serializeRemoteSession,
  sessionUpsertData,
} from "@/lib/code-remote-sessions";

export const runtime = "nodejs";
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const sessionSchema = z.object({
  sessionId: z.string().min(1).max(200),
  workspaceId: z.string().max(200).nullable().optional(),
  workspaceKey: z.string().max(200).nullable().optional(),
  workspaceName: z.string().max(500).nullable().optional(),
  projectId: z.string().max(200).nullable().optional(),
  projectName: z.string().max(500).nullable().optional(),
  title: z.string().min(1).max(500),
  titleSource: z.string().max(100).optional(),
  modelId: z.string().min(1).max(300),
  reasoningEffort: z.string().max(100).nullable().optional(),
  rolePreset: z.string().max(100).optional(),
  permissionMode: z.string().max(100).optional(),
  origin: z.enum(["local", "remote"]).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastMessageAt: z.string().datetime(),
  currentStatus: z.enum(SESSION_STATUSES).optional(),
  isRunning: z.boolean().optional(),
  isAwaitingApproval: z.boolean().optional(),
  pendingChangeCount: z.number().int().min(0).optional(),
  activeBranch: z.string().max(500).nullable().optional(),
  gitDirtyState: z.string().max(100).nullable().optional(),
  lastError: z.string().max(10_000).nullable().optional(),
  lastEventSequence: z.number().int().min(0).optional(),
  transcriptVersion: z.number().int().min(1).optional(),
  snapshotVersion: z.number().int().min(1).optional(),
  transcriptPolicy: z.enum(TRANSCRIPT_POLICIES).optional(),
  indexedSearch: z.string().max(200_000).optional(),
});

const syncSchema = z.object({
  listVersion: z.number().int().min(1),
  transcriptPolicy: z.enum(TRANSCRIPT_POLICIES).default("metadata"),
  sessions: z.array(sessionSchema).max(5000),
  deletedSessionIds: z.array(z.string().min(1).max(200)).max(5000).optional(),
});

async function ownedDevice(deviceId: string, userId: string) {
  return prisma.codeDevice.findFirst({ where: { id: deviceId, userId } });
}

export async function GET(req: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { deviceId } = await params;
  const device = await ownedDevice(deviceId, user.id);
  if (!device) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const searchParams = new URL(req.url).searchParams;
  const cursor = decodeCursor(searchParams.get("cursor"));
  if (searchParams.get("cursor") && !cursor) return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
  const rawLimit = Number(searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 200) : 50;
  const status = searchParams.get("status") ?? undefined;
  if (status && !(SESSION_STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }
  const archived = searchParams.get("archived");
  const pinned = searchParams.get("pinned");
  const origin = searchParams.get("origin");
  if (archived && archived !== "true" && archived !== "false") return NextResponse.json({ error: "Invalid archived" }, { status: 400 });
  if (pinned && pinned !== "true" && pinned !== "false") return NextResponse.json({ error: "Invalid pinned" }, { status: 400 });
  if (origin && origin !== "local" && origin !== "remote") return NextResponse.json({ error: "Invalid origin" }, { status: 400 });
  const updatedAfterRaw = searchParams.get("updatedAfter");
  const updatedAfter = updatedAfterRaw ? new Date(updatedAfterRaw) : null;
  if (updatedAfter && Number.isNaN(updatedAfter.getTime())) return NextResponse.json({ error: "Invalid updatedAfter" }, { status: 400 });
  const search = searchParams.get("search")?.trim().slice(0, 500);
  const workspaceKey = searchParams.get("workspaceKey") ?? undefined;
  const projectId = searchParams.get("projectId") ?? undefined;

  const where: Prisma.CodeRemoteSessionWhereInput = {
    userId: user.id,
    deviceId,
    deletedAt: null,
    ...(workspaceKey ? { workspaceKey } : {}),
    ...(projectId ? { projectId } : {}),
    ...(status ? { currentStatus: status } : {}),
    ...(archived ? { archived: archived === "true" } : {}),
    ...(pinned ? { pinned: pinned === "true" } : {}),
    ...(origin ? { origin } : {}),
    ...(search ? { indexedSearch: { contains: search, mode: "insensitive" } } : {}),
    ...(updatedAfter ? { sessionUpdatedAt: { gt: updatedAfter } } : {}),
    ...(cursor
      ? {
          OR: [
            { sessionUpdatedAt: { lt: cursor.updatedAt } },
            { sessionUpdatedAt: cursor.updatedAt, id: { lt: cursor.id } },
          ],
        }
      : {}),
  };

  const sessions = await prisma.codeRemoteSession.findMany({
    where,
    orderBy: [{ sessionUpdatedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const hasMore = sessions.length > limit;
  const page = hasMore ? sessions.slice(0, limit) : sessions;
  const online = deviceIsOnline(device.lastSeenAt);
  return NextResponse.json({
    sessions: page.map((session) => serializeRemoteSession(session, online)),
    nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1]) : null,
    listVersion: device.sessionListVersion,
    device: { online, lastSeenAt: device.lastSeenAt.toISOString(), stale: !online },
  });
}

/// Host snapshot ingestion. Every local Conversation(kind: .code), including
/// pre-Remote and workspace-less rows, is upserted by the stable (device,session)
/// key. Missing rows are NOT inferred as deletes; the host must send explicit
/// tombstones so a partial/paginated sync cannot erase history.
export async function PUT(req: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { deviceId } = await params;
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  const parsed = syncSchema.safeParse(JSON.parse(raw || "null"));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const device = await ownedDevice(deviceId, user.id);
  if (!device) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { sessions, deletedSessionIds = [], transcriptPolicy, listVersion } = parsed.data;
  await prisma.$transaction(async (tx) => {
    for (const input of sessions) {
      const data = sessionUpsertData(input, input.transcriptPolicy ?? transcriptPolicy);
      // A metadata re-sync must never move the event high-water mark or the
      // snapshot/transcript generation backwards — those columns are owned by
      // the events-POST and detail-snapshot routes. Reset them only on create.
      const { lastEventSequence: _seq, transcriptVersion: _tv, snapshotVersion: _sv, createdAt: _c, ...updateData } = data;
      await tx.codeRemoteSession.upsert({
        where: { deviceId_sessionId: { deviceId, sessionId: input.sessionId } },
        create: { userId: user.id, deviceId, ...data },
        update: updateData,
      });
    }
    if (deletedSessionIds.length) {
      await tx.codeRemoteSession.updateMany({
        where: { userId: user.id, deviceId, sessionId: { in: deletedSessionIds } },
        data: { deletedAt: new Date(), isRunning: false, isAwaitingApproval: false, currentStatus: "interrupted" },
      });
    }
    const [sessionCount, activeCount] = await Promise.all([
      tx.codeRemoteSession.count({ where: { userId: user.id, deviceId, deletedAt: null } }),
      tx.codeRemoteSession.count({ where: { userId: user.id, deviceId, deletedAt: null, isRunning: true } }),
    ]);
    await tx.codeDevice.update({
      where: { id: deviceId, userId: user.id },
      // Bump the session-inventory generation, NOT the wire protocol version —
      // conflating them made a phone read the list counter as the device's
      // negotiated protocol after any sync.
      data: { sessionListVersion: listVersion, sessionCount, activeCount, lastSeenAt: new Date() },
    });
  });
  return NextResponse.json({ ok: true, count: sessions.length, listVersion });
}

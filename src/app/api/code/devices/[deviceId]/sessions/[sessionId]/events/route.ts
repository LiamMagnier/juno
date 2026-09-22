import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import {
  MAX_EVENT_BATCH_BYTES,
  SESSION_EVENT_KINDS,
  checkSessionEventBatch,
  chunkEventFrames,
  deriveSessionStatusFields,
  planSessionEventAppend,
  serializeSessionEvent,
} from "@/lib/code-remote-sessions";

export const runtime = "nodejs";
export const maxDuration = 300;

const postSchema = z.object({
  events: z.array(z.object({
    seq: z.number().int().min(1),
    kind: z.enum(SESSION_EVENT_KINDS),
    payload: z.record(z.string(), z.unknown()),
    createdAt: z.string().datetime().optional(),
  })).min(1).max(500),
});

async function ownedSession(deviceId: string, sessionId: string, userId: string) {
  return prisma.codeRemoteSession.findFirst({ where: { deviceId, sessionId, userId, deletedAt: null } });
}

/// Host append. Sequence is host-assigned and monotone; the compound unique key
/// makes reconnect/replay idempotent. A gap is rejected instead of silently
/// producing a transcript that looks complete, and names the sequence the host
/// must resume from. Size is bounded per request and per event, and a batch
/// that repeats a sequence is refused whole rather than half-stored.
export async function POST(req: Request, { params }: { params: Promise<{ deviceId: string; sessionId: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { deviceId, sessionId } = await params;
  const session = await ownedSession(deviceId, sessionId, user.id);
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_EVENT_BATCH_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const check = checkSessionEventBatch(parsed.data.events);
  if (!check.ok) return NextResponse.json({ error: check.error, seq: check.seq }, { status: check.status });
  const plan = planSessionEventAppend(session.lastEventSequence, parsed.data.events);
  if (!plan.ok) return NextResponse.json({ error: plan.error, expectedSeq: plan.expectedSeq }, { status: 409 });
  if (plan.accepted.length) {
    const statusFields = deriveSessionStatusFields(plan.status);
    await prisma.$transaction(async (tx) => {
      await tx.codeRemoteSessionEvent.createMany({
        data: plan.accepted.map((event) => ({
          userId: user.id,
          deviceId,
          remoteSessionId: session.id,
          sessionId,
          seq: event.seq,
          kind: event.kind,
          payload: event.payload as Prisma.InputJsonValue,
          createdAt: event.createdAt ? new Date(event.createdAt) : new Date(),
        })),
        skipDuplicates: true,
      });
      // Only ever forward: two appends racing from the same stale read both
      // plan from it, and the later commit must not pull the high-water mark
      // back below what the earlier one stored.
      await tx.codeRemoteSession.updateMany({
        where: { id: session.id, userId: user.id, lastEventSequence: { lt: plan.lastSeq } },
        data: {
          lastEventSequence: plan.lastSeq,
          syncedAt: new Date(),
          ...(statusFields ?? {}),
        },
      });
    });
  }
  return NextResponse.json({ lastSeq: plan.lastSeq });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/// SSE for phones/web. Reconnect with afterSeq; sequence keys make client-side
/// merge deterministic and avoid duplicated deltas.
export async function GET(req: Request, { params }: { params: Promise<{ deviceId: string; sessionId: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { deviceId, sessionId } = await params;
  const session = await ownedSession(deviceId, sessionId, user.id);
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  const raw = Number(new URL(req.url).searchParams.get("afterSeq") ?? "0");
  let cursor = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  // A bounded snapshot remains the compatibility/recovery path for clients
  // that cannot hold an SSE connection (including previews). It uses the same
  // strict `afterSeq` cursor and serialized payload as the stream, never a
  // separate transcript vocabulary.
  if (req.headers.get("accept")?.includes("application/json")) {
    const events = await prisma.codeRemoteSessionEvent.findMany({
      where: { userId: user.id, remoteSessionId: session.id, seq: { gt: cursor } },
      orderBy: { seq: "asc" },
      take: 500,
    });
    return NextResponse.json({
      events: events.map(serializeSessionEvent),
      lastSeq: events.at(-1)?.seq ?? cursor,
    });
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (frame: unknown) => controller.enqueue(encoder.encode(`event: events\ndata: ${JSON.stringify(frame)}\n\n`));
      const deadline = Date.now() + 4 * 60_000;
      let lastHeartbeat = 0;
      try {
        while (!req.signal.aborted && Date.now() < deadline) {
          const events = await prisma.codeRemoteSessionEvent.findMany({
            where: { userId: user.id, remoteSessionId: session.id, seq: { gt: cursor } },
            orderBy: { seq: "asc" },
            take: 500,
          });
          if (events.length) {
            cursor = events[events.length - 1].seq;
            // Several bounded frames rather than one line per page: each
            // frame's `lastSeq` is its own last event, which is what the
            // client checks a frame against.
            for (const frame of chunkEventFrames(events.map(serializeSessionEvent))) {
              send({ type: "events", events: frame, lastSeq: frame[frame.length - 1].seq });
            }
            lastHeartbeat = Date.now();
          } else if (Date.now() - lastHeartbeat > 15_000) {
            controller.enqueue(encoder.encode(`: heartbeat ${cursor}\n\n`));
            lastHeartbeat = Date.now();
          }
          await sleep(1_000);
        }
      } finally {
        try { controller.close(); } catch { /* already disconnected */ }
      }
    },
  });
  return new Response(stream, { headers: {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  }});
}

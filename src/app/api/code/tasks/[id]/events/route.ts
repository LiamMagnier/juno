import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { codeTaskMessageId, appendTaskEvents, EVENT_KINDS, isTerminalTaskStatus, persistCodeTaskOutcome, requireUser, serializeTask, serializeTaskEvent, TASK_STATUSES } from "@/lib/code-remote";
import { serializeMessage } from "@/lib/serializers";

export const runtime = "nodejs";
// Vercel-only directive (`next start` ignores it); harmless self-hosted, keeps
// the stream alive on platforms that enforce it.
export const maxDuration = 300;

const MAX_BODY_BYTES = 256 * 1024;

const schema = z.object({
  events: z
    .array(
      z.object({
        kind: z.enum(EVENT_KINDS),
        payload: z.record(z.string(), z.unknown()),
      }),
    )
    .max(500),
  status: z.enum(TASK_STATUSES).optional(),
  afterControlSeq: z.number().int().min(0).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const task = await prisma.codeTask.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { task: updated, lastSeq, control } = await appendTaskEvents(
    task.id,
    parsed.data.events.map((event) => ({
      kind: event.kind,
      payload: event.payload as Prisma.InputJsonValue,
    })),
    { status: parsed.data.status, afterControlSeq: parsed.data.afterControlSeq ?? 0 },
  );

  // Task just finished (done/failed/cancelled): write the linked session's
  // ASSISTANT message before acking, so the web stream's terminal frame can
  // hand the client a persisted row. Idempotent; must never break the ack.
  if (isTerminalTaskStatus(updated.status)) {
    try {
      await persistCodeTaskOutcome(updated);
    } catch (err) {
      console.error("[code-remote] failed to persist task outcome", err);
    }
  }

  return NextResponse.json({ lastSeq, control });
}

// ─── Live task stream (web client) ──────────────────────────────────────────
//
// GET streams the task's event log as SSE for the code session view:
//
//   data: { type: "snapshot", task, events }        — on connect (seq > afterSeq)
//   data: { type: "events", task, events }          — as the host posts more
//   data: { type: "done", task, message }           — terminal; `message` is the
//                                                     persisted ASSISTANT row for
//                                                     linked tasks (null otherwise)
//   : ping                                          — keep-alive comment
//
// The client reconnects with ?afterSeq=<lastSeq> after any drop; the stream
// also self-limits to a window so proxies never hold it forever.
const POLL_INTERVAL_MS = 1_200;
const HEARTBEAT_MS = 15_000;
const STREAM_WINDOW_MS = 4 * 60_000;
// The outcome message is written by the host's final events POST; give it a
// short grace period before emitting the terminal frame without it.
const OUTCOME_GRACE_MS = 5_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const task = await prisma.codeTask.findFirst({ where: { id, userId: user.id } });
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const rawAfterSeq = Number(new URL(req.url).searchParams.get("afterSeq") ?? "0");
  let cursor = Number.isFinite(rawAfterSeq) && rawAfterSeq > 0 ? Math.floor(rawAfterSeq) : 0;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (frame: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      const readEvents = () =>
        prisma.codeTaskEvent.findMany({
          where: { taskId: id, seq: { gt: cursor } },
          orderBy: { seq: "asc" },
          take: 500,
        });
      const closedBy = new Promise<"abort">((resolve) => {
        req.signal.addEventListener("abort", () => resolve("abort"), { once: true });
      });
      let aborted = false;
      void closedBy.then(() => {
        aborted = true;
      });

      try {
        let current = task;
        const initial = await readEvents();
        if (initial.length > 0) cursor = initial[initial.length - 1].seq;
        send({ type: "snapshot", task: serializeTask(current), events: initial.map(serializeTaskEvent) });

        const deadline = Date.now() + STREAM_WINDOW_MS;
        let lastBeat = Date.now();
        while (!aborted && Date.now() < deadline) {
          await sleep(POLL_INTERVAL_MS);
          if (aborted) break;
          const [fresh, events] = await Promise.all([
            prisma.codeTask.findFirst({ where: { id, userId: user.id } }),
            readEvents(),
          ]);
          if (!fresh) break; // deleted underneath us — the client refetches and sees 404
          current = fresh;
          if (events.length > 0) {
            cursor = events[events.length - 1].seq;
            send({ type: "events", task: serializeTask(current), events: events.map(serializeTaskEvent) });
            lastBeat = Date.now();
          }
          if (isTerminalTaskStatus(current.status)) {
            // Flush any stragglers, then attach the persisted outcome message.
            const tail = await readEvents();
            if (tail.length > 0) {
              cursor = tail[tail.length - 1].seq;
              send({ type: "events", task: serializeTask(current), events: tail.map(serializeTaskEvent) });
            }
            let message = null;
            if (current.conversationId) {
              const graceUntil = Date.now() + OUTCOME_GRACE_MS;
              for (;;) {
                const row = await prisma.message.findFirst({
                  where: { id: codeTaskMessageId(current.id), conversationId: current.conversationId },
                  include: { attachments: true },
                });
                if (row) {
                  message = await serializeMessage(row);
                  break;
                }
                if (aborted || Date.now() >= graceUntil) break;
                await sleep(500);
              }
            }
            send({ type: "done", task: serializeTask(current), message });
            break;
          }
          if (Date.now() - lastBeat >= HEARTBEAT_MS) {
            controller.enqueue(encoder.encode(`: ping\n\n`));
            lastBeat = Date.now();
          }
        }
      } catch {
        // Drop the stream; the client reconnects from its cursor.
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

import { NextResponse } from "next/server";
import type { WorkEvent, WorkRun, WorkSession } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { isTerminalStatus } from "@/lib/work/domain";
import { serializeEvent, serializeRun, serializeSession } from "@/lib/work/serializers";

export const runtime = "nodejs";
// Vercel-only directive (`next start` ignores it); harmless self-hosted, keeps
// the stream alive on platforms that enforce it.
export const maxDuration = 300;

// ─── Live session stream ────────────────────────────────────────────────────
//
// GET streams the session's current run as SSE:
//
//   data: { type: "snapshot", session, run, events }  — on connect, and again
//                                                       whenever a newer attempt
//                                                       takes over
//   data: { type: "events", session, run, events }    — as the executor appends
//   data: { type: "done", session, run }              — the run reached a
//                                                       terminal status
//   : ping                                            — keep-alive comment
//
// `seq` is unique per RUN, not per session, so a resuming client sends both
// halves of its cursor: `?runId=<id>&after=<seq>`. A cursor for a run that is
// no longer current is ignored and the client gets a fresh snapshot, because
// replaying attempt 2 from attempt 1's sequence would silently skip whatever
// the new attempt has already done.
const POLL_INTERVAL_MS = 1_200;
const HEARTBEAT_MS = 15_000;
const STREAM_WINDOW_MS = 4 * 60_000;
const EVENT_PAGE = 500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Session or native user bearer, and nothing else. A host token or a run
  // token must never open this stream: those belong to an executor, which gets
  // the events it needs through the relay, whereas this is the user's own
  // transcript of their own session.
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const session = await prisma.workSession.findFirst({
    where: { id, userId: user.id, deletedAt: null },
  });
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const url = new URL(req.url);
  const rawAfter = Number(url.searchParams.get("after") ?? "0");
  const resumeAfter = Number.isFinite(rawAfter) && rawAfter > 0 ? Math.floor(rawAfter) : 0;
  const resumeRunId = url.searchParams.get("runId");

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (frame: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));

      let cursor = 0;
      let currentRunId: string | null = null;
      let currentStatus = "";

      const currentRun = () =>
        prisma.workRun.findFirst({
          where: { sessionId: id, userId: user.id },
          orderBy: { attempt: "desc" },
        });

      const readEvents = (runId: string) =>
        prisma.workEvent.findMany({
          where: { runId, userId: user.id, seq: { gt: cursor } },
          orderBy: { seq: "asc" },
          take: EVENT_PAGE,
        });

      /**
       * Advances the cursor over everything read, and returns only what this
       * reader may see.
       *
       * The cursor moves past filtered-out rows deliberately. Leaving it behind
       * an operator-only event would make every subsequent poll re-read the
       * same row and deliver nothing, for the life of the stream.
       */
      const deliver = (rows: WorkEvent[]) => {
        if (rows.length > 0) cursor = rows[rows.length - 1].seq;
        return rows.filter((row) => row.visibility === "user").map(serializeEvent);
      };

      const frame = (type: string, current: WorkSession, run: WorkRun | null, events: unknown[]) =>
        send({
          type,
          session: serializeSession(current),
          run: run ? serializeRun(run) : null,
          events,
        });

      const closedBy = new Promise<"abort">((resolve) => {
        req.signal.addEventListener("abort", () => resolve("abort"), { once: true });
      });
      let aborted = false;
      void closedBy.then(() => {
        aborted = true;
      });

      try {
        let live = session;
        const run = await currentRun();
        if (run) {
          currentRunId = run.id;
          currentStatus = run.status;
          cursor = resumeRunId === run.id ? resumeAfter : 0;
        }
        frame("snapshot", live, run, run ? deliver(await readEvents(run.id)) : []);

        const deadline = Date.now() + STREAM_WINDOW_MS;
        let lastBeat = Date.now();
        while (!aborted && Date.now() < deadline) {
          await sleep(POLL_INTERVAL_MS);
          if (aborted) break;

          const [fresh, freshRun] = await Promise.all([
            prisma.workSession.findFirst({ where: { id, userId: user.id } }),
            currentRun(),
          ]);
          // Deleted underneath us. The client refetches and sees the 404, which
          // is the honest answer; continuing to stream a deleted session's
          // events would be the one thing deleting it was meant to stop.
          if (!fresh || fresh.deletedAt) break;
          live = fresh;

          if (freshRun && freshRun.id !== currentRunId) {
            // A newer attempt took over. Its sequence starts again at 1, so the
            // cursor resets with it and the client is re-based rather than sent
            // events whose seq it has already seen from another run.
            currentRunId = freshRun.id;
            currentStatus = freshRun.status;
            cursor = 0;
            frame("snapshot", live, freshRun, deliver(await readEvents(freshRun.id)));
            lastBeat = Date.now();
            continue;
          }

          const events = freshRun ? deliver(await readEvents(freshRun.id)) : [];
          const statusMoved = (freshRun?.status ?? "") !== currentStatus;
          currentStatus = freshRun?.status ?? "";
          if (events.length > 0 || statusMoved) {
            frame("events", live, freshRun, events);
            lastBeat = Date.now();
          }

          if (freshRun && isTerminalStatus(freshRun.status)) {
            // Flush whatever landed between the read above and the terminal
            // transition, so the last thing the run said is not lost to the
            // race between its final event and its final status.
            const tail = deliver(await readEvents(freshRun.id));
            if (tail.length > 0) frame("events", live, freshRun, tail);
            frame("done", live, freshRun, []);
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

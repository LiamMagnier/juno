import { NextResponse } from "next/server";
import type { WorkEvent, WorkRun, WorkSession } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { isTerminalStatus } from "@/lib/work/domain";
import { serializeEvent, serializeRun, serializeSession } from "@/lib/work/serializers";
import { pendingApprovalsForRun } from "@/lib/work/approvals";

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
/*
 * Two poll intervals, and why there are two.
 *
 * A single 1.2s poll costs the run's whole transcript up to 1.2s of latency per
 * line, and a burst of quick tool calls arrives as one clump rather than as
 * things happening — which is the difference between a page that shows what the
 * agent is doing and a page that shows what it did a moment ago. Simply lowering
 * the interval is the wrong trade: an idle session is the common case, most
 * sessions are idle most of the time, and every one of them would query Postgres
 * four times as often for nothing.
 *
 * So the interval follows the run. A poll that found something schedules the
 * next few quickly, because a run that just emitted is overwhelmingly likely to
 * emit again; a poll that found nothing decays back to the idle rate within a
 * few seconds. The floor is 300ms and there is always a sleep, so this is a
 * slower loop under load, never a busy one — the steady-state cost of a session
 * nobody is working on is exactly what it was.
 */
const IDLE_POLL_MS = 1_200;
const ACTIVE_POLL_MS = 300;
/** ~3.6s of fast polling after each sign of life, then back to idle. */
const ACTIVE_POLL_BUDGET = 12;
const HEARTBEAT_MS = 15_000;
/**
 * How long one connection lasts before the client is asked to reconnect.
 *
 * Comfortably inside the 300s `maxDuration` above, so the close is ours and
 * lands between frames, rather than the platform's and landing mid-frame.
 * `subscribeToWorkEvents` treats a clean end of body as the normal path and
 * reconnects immediately from its cursor without counting it against the
 * backoff, which is what makes a window this short invisible.
 */
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
      let currentUsage = "";

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

      /**
       * What the run has spent, as one comparable string.
       *
       * The three usage columns move without any event being written — the
       * executor bills a turn, the row changes, and nothing in the transcript
       * says so. Without this the cost and token readouts froze for the whole
       * of a long tool call and then jumped, which reads as a stalled page
       * rather than as a quiet minute.
       */
      const usageOf = (run: WorkRun | null) =>
        run === null ? "" : `${run.costMicroUsd}:${run.inputTokens}:${run.outputTokens}`;

      /**
       * One frame, with everything the clients decode from it.
       *
       * `approvals` was missing, and its absence is why the approval card never
       * appeared on a Mac or a phone: `NativeWorkClient.decodeFrame` reads an
       * `approvals` key out of every frame type and this route sent none, so
       * `NativeWorkModel.pendingApprovals` stayed empty for the whole life of a
       * run that had stopped to ask for permission.
       *
       * Read on each frame rather than each poll. Frames are only sent when
       * something actually moved — an event landed, the status changed, the
       * spend changed — so this is one small indexed query per *change*, not
       * one per second. Raising an approval moves the run to `waiting_approval`
       * and answering it moves the run off it, so both transitions already send
       * a frame and both therefore carry the fresh list.
       */
      const frame = async (
        type: string,
        current: WorkSession,
        run: WorkRun | null,
        events: unknown[]
      ) =>
        send({
          type,
          session: serializeSession(current),
          run: run ? serializeRun(run) : null,
          events,
          approvals: await pendingApprovalsForRun(run?.id, user.id),
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
          currentUsage = usageOf(run);
          cursor = resumeRunId === run.id ? resumeAfter : 0;
        }
        await frame("snapshot", live, run, run ? deliver(await readEvents(run.id)) : []);

        const deadline = Date.now() + STREAM_WINDOW_MS;
        let lastBeat = Date.now();
        // A run that is still going when the page attaches gets the fast rate
        // straight away. This is the moment the user has just pressed Start and
        // is watching an empty panel, and it is the one moment where a second of
        // silence is read as "nothing happened" rather than as latency.
        let activePolls = run !== null && !isTerminalStatus(run.status) ? ACTIVE_POLL_BUDGET : 0;

        while (!aborted && Date.now() < deadline) {
          await sleep(activePolls > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS);
          if (activePolls > 0) activePolls -= 1;
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
            currentUsage = usageOf(freshRun);
            cursor = 0;
            await frame("snapshot", live, freshRun, deliver(await readEvents(freshRun.id)));
            lastBeat = Date.now();
            activePolls = ACTIVE_POLL_BUDGET;
            continue;
          }

          const events = freshRun ? deliver(await readEvents(freshRun.id)) : [];
          const statusMoved = (freshRun?.status ?? "") !== currentStatus;
          const usage = usageOf(freshRun);
          const spent = usage !== currentUsage;
          currentStatus = freshRun?.status ?? "";
          currentUsage = usage;
          if (events.length > 0 || statusMoved || spent) {
            await frame("events", live, freshRun, events);
            lastBeat = Date.now();
            // Any sign of life buys the next few seconds at the fast rate. A run
            // mid-turn emits in bursts, and the poll that catches the first line
            // of a burst is the one best placed to catch the rest of it.
            activePolls = ACTIVE_POLL_BUDGET;
          }

          if (freshRun && isTerminalStatus(freshRun.status)) {
            // Flush whatever landed between the read above and the terminal
            // transition, so the last thing the run said is not lost to the
            // race between its final event and its final status.
            const tail = deliver(await readEvents(freshRun.id));
            if (tail.length > 0) await frame("events", live, freshRun, tail);
            await frame("done", live, freshRun, []);
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

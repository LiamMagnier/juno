import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { liveRunsDigest } from "@/lib/runs/live-runs";
import { loadLiveRuns } from "@/lib/runs/remote-control-prisma";

export const runtime = "nodejs";
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "no-store" } as const;
/** How often the stream re-reads. The phone's Live Activity budget is 5 s. */
const POLL_MS = 2_000;
const HEARTBEAT_MS = 15_000;
/** Rotated before the platform's request limit; clients reconnect. */
const STREAM_LIFETIME_MS = 4 * 60_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Every live run on the account: Code sessions on paired Macs and Work
 * attempts on a Mac or in the cloud, with steps, the current action, elapsed
 * time, cost when known and any pending approvals.
 *
 * `Accept: application/json` answers one snapshot. Anything else is an SSE
 * feed in the relay's shape (`event: runs`): a full snapshot whenever anything
 * a row shows changes, a heartbeat comment otherwise, rotated after four
 * minutes. A frame is always the whole list, never a delta, so a reconnect
 * cannot miss a run ending.
 */
export async function GET(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;

  if (req.headers.get("accept")?.includes("application/json")) {
    const runs = await loadLiveRuns(user.id);
    return NextResponse.json({ runs, generatedAt: new Date().toISOString() }, { headers: NO_STORE });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const deadline = Date.now() + STREAM_LIFETIME_MS;
      let lastDigest: string | null = null;
      let lastSent = 0;
      try {
        while (!req.signal.aborted && Date.now() < deadline) {
          const runs = await loadLiveRuns(user.id);
          const digest = liveRunsDigest(runs);
          if (digest !== lastDigest) {
            lastDigest = digest;
            const frame = { type: "runs", runs, generatedAt: new Date().toISOString() };
            controller.enqueue(encoder.encode(`event: runs\ndata: ${JSON.stringify(frame)}\n\n`));
            lastSent = Date.now();
          } else if (Date.now() - lastSent > HEARTBEAT_MS) {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
            lastSent = Date.now();
          }
          await sleep(POLL_MS);
        }
      } catch (err) {
        console.warn("[runs-live] stream ended", err instanceof Error ? err.message : String(err));
      } finally {
        try {
          controller.close();
        } catch {
          // Already disconnected.
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      ...NO_STORE,
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

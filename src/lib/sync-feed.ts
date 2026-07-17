import "server-only";
import { prisma } from "@/lib/prisma";
import {
  changeEnvelope,
  ensureCursorAboveFloor,
} from "@/lib/sync-protocol";

/*
 * Server side of the account change feed, shared by the bearer-auth native
 * contract (/api/v1/changes, /api/v1/changes/stream) and its cookie-session
 * twin for the shipping app (/api/sync/changes, /api/sync/stream). Routes own
 * authentication and error envelopes; payload shapes and stream semantics
 * live here exactly once.
 */

/** Highest AccountChange cursor the retention pruner has deleted (0n before
 *  the first prune). Written only by scripts/prune-sync.ts. */
export async function getCompactionFloor(): Promise<bigint> {
  const row = await prisma.syncCompaction.findUnique({ where: { id: "global" } });
  return row?.floorCursor ?? 0n;
}

/**
 * One page of the account change feed. Throws CursorCompactedError when
 * `after` predates the compaction floor (the caller answers 410).
 */
export async function listAccountChanges(accountId: string, after: bigint, limit: number) {
  const floor = await getCompactionFloor();
  ensureCursorAboveFloor(after, floor);
  const rows = await prisma.accountChange.findMany({
    where: { accountId, cursor: { gt: after } },
    orderBy: { cursor: "asc" },
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const nextCursor = page.at(-1)?.cursor ?? after;
  return {
    after: after.toString(),
    changes: page.map(changeEnvelope),
    nextCursor: nextCursor.toString(),
    compactionFloorCursor: floor.toString(),
    hasMore,
  };
}

// Long-lived wake-up stream: hold ~55s (inside the routes' maxDuration = 60),
// poll the account's max cursor every ~2s, emit a `cursor` event per advance,
// heartbeat comment every ~15s, then `done` so healthy clients reconnect.
const STREAM_WINDOW_MS = 55_000;
const POLL_INTERVAL_MS = 2_000;
const HEARTBEAT_MS = 15_000;

async function latestCursor(accountId: string): Promise<bigint> {
  const row = await prisma.accountChange.findFirst({
    where: { accountId },
    orderBy: { cursor: "desc" },
    select: { cursor: true },
  });
  return row?.cursor ?? 0n;
}

/** Abort-aware sleep: resolves early (never rejects) when the signal fires. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * SSE response for the change wake-up stream.
 *
 * `after` semantics: an explicit client watermark emits an immediate catch-up
 * `cursor` event when the account is already ahead of it; `null` (no `after`
 * query param) baselines to the current max cursor so only NEW changes wake
 * the client — the shipping app's SyncLiveness connects bare and treats every
 * cursor event as "run a refresh".
 */
export async function accountChangeStreamResponse(options: {
  accountId: string;
  after: bigint | null;
  signal: AbortSignal;
  headers?: Record<string, string>;
}): Promise<Response> {
  const { accountId, signal } = options;
  const latest = await latestCursor(accountId);
  const baseline = options.after ?? latest;

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (chunk: string) => {
        // The client can vanish between polls; treat a closed controller as abort.
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          return false;
        }
      };
      const event = (name: string, data: string) => enqueue(`event: ${name}\ndata: ${data}\n\n`);

      try {
        let watermark = baseline;
        event("ready", `{"after":"${watermark}"}`);
        if (latest > watermark) {
          event("cursor", `{"cursor":"${latest}"}`);
          watermark = latest;
        }

        const deadline = Date.now() + STREAM_WINDOW_MS;
        let lastActivity = Date.now();
        while (!signal.aborted && Date.now() < deadline) {
          await sleep(POLL_INTERVAL_MS, signal);
          if (signal.aborted) break;
          const cursor = await latestCursor(accountId);
          if (cursor > watermark) {
            // Each advance emits exactly once; equal polls stay silent.
            if (!event("cursor", `{"cursor":"${cursor}"}`)) break;
            watermark = cursor;
            lastActivity = Date.now();
          } else if (Date.now() - lastActivity >= HEARTBEAT_MS) {
            if (!enqueue(": ping\n\n")) break;
            lastActivity = Date.now();
          }
        }
        if (!signal.aborted) event("done", "{}");
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
      ...options.headers,
    },
  });
}

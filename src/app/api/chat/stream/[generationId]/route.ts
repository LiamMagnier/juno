import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { encodeChunk, encodeSseFrame, SSE_HEADERS } from "@/lib/chat-stream";
import { chatReceiptLiveness, findFirstSubmissionReceipt } from "@/lib/chat-first-submission-receipt";
import { findChatStreamMeta, readChatStreamEvents } from "@/lib/chat-stream-log-store";
import { replayStream, type StreamReplayPort } from "@/lib/chat/stream-replay";
import { isGenerationActive, isGenerationLive } from "@/lib/generation-cancel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resume a saved-chat generation whose SSE stream dropped.
 *
 * `GET /api/chat/stream/{generationId}?after={seq}` replays every logged frame
 * with `seq > after` — each under the same `id:` it had the first time — then
 * tails the log until the generation's terminal frame, with a heartbeat every
 * 15s. The client feeds the frames through the same handler as the original
 * stream, so a reconnect is invisible to the transcript.
 *
 * Ownership. A receipt (native durable first submissions) proves it through
 * its userId. Every other saved turn — all of the web — has no receipt, so the
 * proof is the logged `meta` frame: it names the conversation, and the
 * conversation names its owner. Unknown, foreign, private (never logged) and
 * already-swept generations are all the same 404 to the caller.
 *
 * The end. A `done`/`error` frame closes the stream. When the generation is
 * over but no such frame is in the log — the process died, or the log was
 * disabled — the client gets one `resume` frame with `refetch: true` and
 * should load the conversation instead. "Over" is asked of every process: the
 * one serving this request, then the generation's live lease, which whichever
 * process holds it keeps renewed (chat/generation-signals.ts).
 */
const GENERATION_ID = /^[A-Za-z0-9._:-]{8,120}$/;
/**
 * How long one answer about ANOTHER process's live lease is reused. The replay
 * asks for liveness every REPLAY_POLL_MS between frames; the lease is renewed
 * every 5s and lives 20s, so re-reading it more often than this buys nothing.
 */
const REMOTE_LIVENESS_CACHE_MS = 2_000;

function parseAfter(raw: string | null): number {
  const value = Number.parseInt(raw ?? "0", 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export async function GET(req: Request, { params }: { params: Promise<{ generationId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { generationId } = await params;
  if (!GENERATION_ID.test(generationId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const after = parseAfter(new URL(req.url).searchParams.get("after"));

  // Account-scoped, and it expires a stale lease atomically — a receipt left
  // `running` by a dead process reads as terminal from here on.
  const receipt = await findFirstSubmissionReceipt(user.id, { generationId });
  let owned = receipt !== null;
  if (!owned) {
    const meta = await findChatStreamMeta(generationId);
    if (meta) {
      const conversation = await prisma.conversation.findFirst({
        where: { id: meta.conversationId, userId: user.id },
        select: { id: true },
      });
      owned = conversation !== null;
    }
  }
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let remote: { live: boolean; at: number } | null = null;
  const port: StreamReplayPort = {
    eventsAfter: readChatStreamEvents,
    liveness: async (id) => {
      // This process is still generating: whatever the receipt says, frames
      // are still coming.
      if (isGenerationActive(id)) return "running";
      if (receipt) {
        const state = await chatReceiptLiveness(user.id, id);
        return state === "running" ? "running" : "terminal";
      }
      // No receipt and not registered here: another backend process may hold
      // it (a second instance, the old process during a reload). Its live
      // lease says so; with no lease, nothing can append any more.
      if (!remote || Date.now() - remote.at >= REMOTE_LIVENESS_CACHE_MS) {
        const live = await isGenerationLive(id, user.id).catch(() => false);
        remote = { live, at: Date.now() };
      }
      return remote.live ? "running" : "terminal";
    },
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = (bytes: Uint8Array) => {
        try {
          controller.enqueue(bytes);
        } catch {
          /* client went away again — the loop ends on the aborted signal */
        }
      };
      void (async () => {
        try {
          for await (const event of replayStream(port, { generationId, after, signal: req.signal })) {
            if (event.type === "frame") {
              enqueue(encodeSseFrame(event.payload, event.seq));
            } else if (event.type === "heartbeat") {
              enqueue(encodeChunk({ type: "ping" }));
            } else if (event.reason === "refetch" || event.reason === "timeout") {
              enqueue(encodeChunk({ type: "resume", refetch: true }));
            }
          }
        } catch (error) {
          console.error("[chat] stream resume failed", {
            generationId,
            message: error instanceof Error ? error.message : String(error),
          });
          enqueue(encodeChunk({ type: "resume", refetch: true }));
        } finally {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      })();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

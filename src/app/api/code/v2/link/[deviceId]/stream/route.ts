import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { offlineReply } from "@/lib/code-v2/device-link";
import { linkHub } from "@/lib/code-v2/env-link-select";
import { requireRemotePair } from "@/lib/code-v2/device-pairing-guard";
import { LINK_STREAM_LIMITS, linkStreamFrames, sseFrame } from "@/lib/code-v2/link-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The device link's push stream for the phone (src/lib/code-v2/link-stream.ts):
 * POST `{cursors, globalCursor}` and read Server-Sent Events. Each batch the
 * Mac pushes is written the moment it lands, so a streamed answer reaches the
 * phone without a request per batch. The sign-in, the device and the pair are
 * checked once when it opens; the pair again before events go out (at most
 * every few seconds), so a pair removed on the Mac ends the stream.
 * Commands still go through `../` as `{kind:"rpc"}`.
 */
export async function POST(req: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { deviceId } = await params;
  const device = await prisma.codeDevice.findFirst({ where: { id: deviceId, userId: user.id }, select: { id: true, name: true } });
  if (!device) return NextResponse.json({ error: "This computer is not paired with your account." }, { status: 404 });
  const unpaired = await requireRemotePair(req, user.id, device.id);
  if (unpaired) return unpaired;

  const body = (await req.json().catch(() => null)) as { cursors?: unknown; globalCursor?: unknown } | null;
  const cursors: Record<string, number> = {};
  if (body?.cursors && typeof body.cursors === "object") {
    for (const [id, value] of Object.entries(body.cursors as Record<string, unknown>).slice(0, 200)) {
      if (typeof id === "string" && id && typeof value === "number" && Number.isFinite(value)) cursors[id] = Math.floor(value);
    }
  }
  const globalCursor = typeof body?.globalCursor === "number" && Number.isFinite(body.globalCursor) ? Math.floor(body.globalCursor) : -1;

  const link = linkHub().link(user.id, device.id);
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const encoder = new TextEncoder();
  const frames = linkStreamFrames(link, {
    cursors,
    globalCursor,
    signal: abort.signal,
    windowMs: LINK_STREAM_LIMITS.windowMs,
    checkPair: async () => {
      const revoked = await requireRemotePair(req, user.id, device.id);
      if (!revoked) return null;
      const reason = (await revoked.json().catch(() => null)) as { message?: string } | null;
      return reason?.message ?? "This phone is no longer paired with your Mac.";
    },
  });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Opens at once so the phone knows the stream is live.
      controller.enqueue(encoder.encode(": open\n\n"));
      try {
        for await (const frame of frames) {
          const offline = frame.startsWith('data: {"offline":true');
          controller.enqueue(encoder.encode(offline ? sseFrame({ offline: true, ...offlineReply(device.name) }) : frame));
        }
      } catch {
        /* the phone went away, or the hub failed: it reopens */
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      // nginx: never buffer this response.
      "X-Accel-Buffering": "no",
    },
  });
}

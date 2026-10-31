import { NextResponse } from "next/server";
import { z } from "zod";
import { rateLimit } from "@/lib/rate-limit";
import { VOICE_TOOLS_AUDIENCE } from "@/lib/voice-tools";
import { listVoiceTools, loadVoiceCall, runVoiceToolCall, voiceToolCaller, type VoiceToolFrame } from "@/lib/voice-tools-server";

export const runtime = "nodejs";
// A call that waits on the person holds this request open while they decide.
export const maxDuration = 300;

/*
 * A voice call's tools — asked for by the voice relay, server to server
 * (relay/src/tools.ts; what a call carries is src/lib/voice-tools.ts).
 *
 * The relay has no database, no cookie and no connector token. Like its memory
 * and spend callbacks it proves itself with a short-lived HMAC token under the
 * shared AUTH_SECRET, with an audience of its own (`juno.voice.tools`): a spend
 * or memory token cannot list or run a tool, and a session token cannot do
 * either. The call's grant rides inside the signed token — the conversation the
 * app checked was this person's when it minted the call, the connectors the
 * chat had on, the time zone — and is checked again here against the
 * account's own rows (`loadVoiceCall`).
 *
 * GET lists the call's tools. POST runs one and answers with a stream, one JSON
 * object per line: `approval` when the call starts waiting on the person, then
 * one `result`. The stream exists so the card can go up while the broker
 * waits; nothing in it is a credential.
 */

/** Calls one person's voice sessions may run per minute, all sessions together. */
const CALLS_PER_MINUTE = 30;

const callSchema = z.object({
  callId: z.string().min(1).max(200),
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  arguments: z.string().max(64_000),
});

/** The longest one call may hold the request, approval wait included. */
const CALL_MAX_MS = 240_000;

export async function GET(req: Request) {
  const caller = voiceToolCaller(req.headers.get("authorization"), VOICE_TOOLS_AUDIENCE);
  if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const call = await loadVoiceCall(caller);
  if (!call) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await listVoiceTools(call), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const caller = voiceToolCaller(req.headers.get("authorization"), VOICE_TOOLS_AUDIENCE);
  if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = callSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const call = await loadVoiceCall(caller);
  if (!call) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // A voice model that loops on a tool would otherwise run it as fast as it
  // can ask; the chat's turn has a round budget, a call has this.
  const limit = await rateLimit({ key: `voice-tools:${caller.userId}`, limit: CALLS_PER_MINUTE, windowSec: 60 });
  if (!limit.success) {
    const line: VoiceToolFrame = {
      type: "result",
      status: "failed",
      text: "Too many tool calls in a short time, so this one was not run. Say so briefly and wait a moment.",
    };
    return new Response(`${JSON.stringify(line)}\n`, { headers: ndjsonHeaders() });
  }

  // The relay hanging up (the call ended) and the request's own ceiling both
  // stop the dispatcher, which supersedes an approval nobody answered.
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(CALL_MAX_MS)]);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (frame: VoiceToolFrame) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        } catch {
          // The relay is gone; the dispatcher is told through `signal`.
        }
      };
      try {
        await runVoiceToolCall(call, parsed.data, emit, signal);
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed by a cancelled stream.
        }
      }
    },
  });
  return new Response(stream, { headers: ndjsonHeaders() });
}

function ndjsonHeaders(): HeadersInit {
  return {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    // nginx would otherwise hold the approval line until the call finished.
    "X-Accel-Buffering": "no",
  };
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";
import { findAgent, recordAgentEvent } from "@/lib/agents/store";
import { getCurrentDeviceSessionId } from "@/lib/session";
import { isAgentComputerConfigured } from "@/lib/computer/provider";
import {
  computerTakeoverConflict,
  heartbeatComputerViewSession,
  loadAgentComputerStatusPayload,
} from "@/lib/computer/store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

const heartbeatBodySchema = z.object({
  mode: z.enum(["watch", "control"]).default("watch"),
  ended: z.boolean().optional(),
});

/** Watch beats per person and agent per minute: a PiP, an overlay and an app sheet, with room for tab switches. */
const WATCH_BEATS_PER_MINUTE = 10;
/**
 * Control beats have their own, wider ceiling per person and agent. They hold
 * the takeover, so watch beats for other agents can never starve them into a
 * 429 that lets the agent resume while the person is still typing. A Hand
 * back (`ended`) is never limited at all.
 */
const CONTROL_BEATS_PER_MINUTE = 60;

export async function POST(req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;

  // `navigator.sendBeacon` posts text/plain; the body is the same JSON.
  const parsed = heartbeatBodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", message: "Invalid heartbeat payload." },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }
  const { mode, ended } = parsed.data;

  if (!(mode === "control" && ended)) {
    const limit = await rateLimit(
      mode === "control"
        ? { key: `agents:computer-heartbeat-control:${user.id}:${id}`, limit: CONTROL_BEATS_PER_MINUTE, windowSec: 60 }
        : { key: `agents:computer-heartbeat:${user.id}:${id}`, limit: WATCH_BEATS_PER_MINUTE, windowSec: 60 }
    );
    if (!limit.success) {
      return NextResponse.json(
        { error: "rate_limited", message: "Too many heartbeats." },
        { status: 429, headers: NO_STORE_HEADERS }
      );
    }
  }

  const agent = await findAgent(user.id, id);
  if (!agent) {
    return NextResponse.json(
      { error: "not_found", message: "That agent no longer exists." },
      { status: 404, headers: NO_STORE_HEADERS }
    );
  }

  if (!(await isAgentComputerConfigured())) {
    return NextResponse.json(
      { error: "not_enabled", message: "Agent computers are not configured on this server." },
      { status: 404, headers: NO_STORE_HEADERS }
    );
  }

  const deviceSessionId = await getCurrentDeviceSessionId();
  // Control belongs to the client that took it. Another tab or device keeping
  // it or handing it back hears who has it, and nothing changes.
  if (mode === "control") {
    const conflict = await computerTakeoverConflict(user.id, id, deviceSessionId);
    if (conflict) {
      const computer = await loadAgentComputerStatusPayload(user.id, id);
      return NextResponse.json(
        { error: "held_elsewhere", message: conflict, computer },
        { status: 409, headers: NO_STORE_HEADERS }
      );
    }
  }

  // A control heartbeat holds the takeover (the agent's computer tools stay
  // refused); `ended` is Hand back, which releases it.
  await heartbeatComputerViewSession(user.id, id, {
    mode,
    ended,
    deviceSessionId,
  });

  if (ended && mode === "control") {
    await recordAgentEvent({
      userId: user.id,
      agentId: id,
      kind: "takeover_ended",
      title: "Returned computer control",
    });
  }

  const computer = await loadAgentComputerStatusPayload(user.id, id);
  return NextResponse.json({ computer }, { headers: NO_STORE_HEADERS });
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";
import { findAgent, recordAgentEvent } from "@/lib/agents/store";
import { getCurrentDeviceSessionId } from "@/lib/session";
import { computerProvider } from "@/lib/computer/provider";
import { COMPUTER_ACCESS_COPY } from "@/lib/computer/access-copy";
import { ComputerAccessError, computerErrorBody } from "@/lib/computer/errors";
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
 * 429 that lets the agent resume while the person is still typing.
 */
const CONTROL_BEATS_PER_MINUTE = 60;
/**
 * Hand back (`ended`) has a ceiling of its own, shared with no other beat, so
 * nothing else can ever block it. It is still a ceiling: every Hand back
 * rotates the computer's VNC passwords (a process restart on the host) and
 * writes to the agent's timeline, which a loop must not be able to do without
 * end. One Hand back is two or three requests (the overlay, a window's
 * beacon), far below it.
 */
const HAND_BACKS_PER_MINUTE = 20;

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

  const limit = await rateLimit(
    mode === "control" && ended
      ? { key: `agents:computer-hand-back:${user.id}:${id}`, limit: HAND_BACKS_PER_MINUTE, windowSec: 60 }
      : mode === "control"
        ? { key: `agents:computer-heartbeat-control:${user.id}:${id}`, limit: CONTROL_BEATS_PER_MINUTE, windowSec: 60 }
        : { key: `agents:computer-heartbeat:${user.id}:${id}`, limit: WATCH_BEATS_PER_MINUTE, windowSec: 60 }
  );
  if (!limit.success) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many heartbeats." },
      { status: 429, headers: NO_STORE_HEADERS }
    );
  }

  const agent = await findAgent(user.id, id);
  if (!agent) {
    return NextResponse.json(
      { error: "not_found", message: "That agent no longer exists." },
      { status: 404, headers: NO_STORE_HEADERS }
    );
  }

  // Hand back is never refused while there is a computer layer to hand back
  // to; with no computers on this server there is nothing to keep or return.
  if (!computerProvider()) {
    const { status, body } = computerErrorBody(new ComputerAccessError("server_off", COMPUTER_ACCESS_COPY.serverOff));
    return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
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
  // refused); `ended` is Hand back, which releases it. A heartbeat (watch or
  // control) from an account that lost access is answered 403 with the
  // sentence and keeps nothing awake; a control one also releases the take
  // over through the same path as Hand back.
  try {
    await heartbeatComputerViewSession(user.id, id, {
      mode,
      ended,
      deviceSessionId,
      agentName: agent.name,
    });
  } catch (err) {
    const { status, body } = computerErrorBody(err, { fallbackError: "heartbeat_failed" });
    const computer = await loadAgentComputerStatusPayload(user.id, id).catch(() => null);
    return NextResponse.json({ ...body, computer }, { status, headers: NO_STORE_HEADERS });
  }

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

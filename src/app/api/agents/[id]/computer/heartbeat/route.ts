import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";
import { findAgent, recordAgentEvent } from "@/lib/agents/store";
import { getCurrentDeviceSessionId } from "@/lib/session";
import { isAgentComputerConfigured } from "@/lib/computer/provider";
import {
  HEARTBEAT_LIMITS,
  TakeoverHeldError,
  heartbeatComputerViewSession,
  heartbeatRateLimitKey,
  loadAgentComputerStatusPayload,
} from "@/lib/computer/store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

const heartbeatBodySchema = z.object({
  mode: z.enum(["watch", "control"]).default("watch"),
  ended: z.boolean().optional(),
  /** Sent from a hidden tab or a backgrounded app: a control beat holds the takeover longer. */
  hidden: z.boolean().optional(),
});

export async function POST(req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;

  const parsed = heartbeatBodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", message: "Invalid heartbeat payload." },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }
  const { mode, ended, hidden } = parsed.data;

  // Per person, agent and mode: a PiP and an overlay on two agents never
  // share one budget, and control beats (which hold the takeover) get more.
  const limit = await rateLimit({
    key: heartbeatRateLimitKey(user.id, id, mode),
    limit: HEARTBEAT_LIMITS[mode],
    windowSec: HEARTBEAT_LIMITS.windowSec,
  });
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

  if (!(await isAgentComputerConfigured())) {
    return NextResponse.json(
      { error: "not_enabled", message: "Agent computers are not configured on this server." },
      { status: 404, headers: NO_STORE_HEADERS }
    );
  }

  const deviceSessionId = await getCurrentDeviceSessionId();
  // A control heartbeat holds the takeover (the agent's computer tools stay
  // refused); `ended` is Hand back, which releases it. From a client that
  // does not hold the takeover, either one is refused with who does.
  try {
    await heartbeatComputerViewSession(user.id, id, { mode, ended, hidden, deviceSessionId });
  } catch (err) {
    if (err instanceof TakeoverHeldError) {
      const computer = await loadAgentComputerStatusPayload(user.id, id, deviceSessionId);
      return NextResponse.json(
        { error: "takeover_held", message: err.message, computer },
        { status: 409, headers: NO_STORE_HEADERS }
      );
    }
    throw err;
  }

  if (ended && mode === "control") {
    await recordAgentEvent({
      userId: user.id,
      agentId: id,
      kind: "takeover_ended",
      title: "Returned computer control",
    });
  }

  const computer = await loadAgentComputerStatusPayload(user.id, id, deviceSessionId);
  return NextResponse.json({ computer }, { headers: NO_STORE_HEADERS });
}

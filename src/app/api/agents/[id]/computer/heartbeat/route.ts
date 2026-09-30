import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";
import { findAgent, recordAgentEvent } from "@/lib/agents/store";
import { getCurrentDeviceSessionId } from "@/lib/session";
import { isAgentComputerConfigured } from "@/lib/computer/provider";
import {
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

export async function POST(req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;

  const limit = await rateLimit({
    key: `agents:computer-heartbeat:${user.id}`,
    limit: 10,
    windowSec: 60,
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

  const parsed = heartbeatBodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", message: "Invalid heartbeat payload." },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  const { mode, ended } = parsed.data;
  // A control heartbeat holds the takeover (the agent's computer tools stay
  // refused); `ended` is Hand back, which releases it.
  await heartbeatComputerViewSession(user.id, id, {
    mode,
    ended,
    deviceSessionId: await getCurrentDeviceSessionId(),
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

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";
import { findAgent, recordAgentEvent } from "@/lib/agents/store";
import { isAgentComputerConfigured } from "@/lib/computer/provider";
import {
  AsleepComputerError,
  openComputerViewSession,
} from "@/lib/computer/store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const VIEW_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
} as const;

const viewBodySchema = z.object({
  mode: z.enum(["watch", "control"]).default("watch"),
  handoff: z.boolean().optional(),
});

export async function POST(req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;

  const limit = await rateLimit({
    key: `agents:computer-view:${user.id}`,
    limit: 60,
    windowSec: 3600,
  });
  if (!limit.success) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many viewer requests. Try again shortly." },
      { status: 429, headers: VIEW_HEADERS }
    );
  }

  const agent = await findAgent(user.id, id);
  if (!agent) {
    return NextResponse.json(
      { error: "not_found", message: "That agent no longer exists." },
      { status: 404, headers: VIEW_HEADERS }
    );
  }

  if (!(await isAgentComputerConfigured())) {
    return NextResponse.json(
      { error: "not_enabled", message: "Agent computers are not configured on this server." },
      { status: 404, headers: VIEW_HEADERS }
    );
  }

  const parsed = viewBodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", message: "Invalid view request." },
      { status: 400, headers: VIEW_HEADERS }
    );
  }

  const { mode, handoff } = parsed.data;
  const fallbackOrigin = new URL(req.url).origin;

  try {
    const session = await openComputerViewSession(user.id, id, mode, {
      handoff,
      fallbackOrigin,
    });

    if (mode === "control") {
      await recordAgentEvent({
        userId: user.id,
        agentId: id,
        kind: "takeover_started",
        title: "Took over computer",
      });
    }

    if (session.kind === "handoff") {
      return NextResponse.json({ url: session.url }, { headers: VIEW_HEADERS });
    }

    return NextResponse.json(
      {
        mode: session.mode,
        relayUrl: session.relayUrl,
        token: session.token,
        password: session.password,
      },
      { headers: VIEW_HEADERS }
    );
  } catch (err) {
    if (err instanceof AsleepComputerError) {
      return NextResponse.json({ error: "asleep" }, { status: 409, headers: VIEW_HEADERS });
    }
    return NextResponse.json(
      { error: "view_failed", message: "Unable to open computer viewer." },
      { status: 409, headers: VIEW_HEADERS }
    );
  }
}

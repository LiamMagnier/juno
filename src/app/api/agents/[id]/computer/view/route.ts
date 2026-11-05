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
  AsleepComputerError,
  TakeoverHeldElsewhereError,
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

  // No computers on this server: answered here, before the store, so a
  // request writes nothing (as the files and heartbeat routes do).
  if (!computerProvider()) {
    const { status, body } = computerErrorBody(new ComputerAccessError("server_off", COMPUTER_ACCESS_COPY.serverOff));
    return NextResponse.json(body, { status, headers: VIEW_HEADERS });
  }

  // Per agent: a person watching two agents' computers (a PiP each, an
  // overlay, the apps) must not run one shared budget dry.
  const limit = await rateLimit({
    key: `agents:computer-view:${user.id}:${id}`,
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

  const parsed = viewBodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", message: "Invalid view request." },
      { status: 400, headers: VIEW_HEADERS }
    );
  }

  const { mode, handoff } = parsed.data;
  const fallbackOrigin = new URL(req.url).origin;
  const deviceSessionId = await getCurrentDeviceSessionId();

  try {
    // Access (provider, rollout, plan, host, allowance) first, inside the
    // store: no app link is minted for an account that may not use it.
    const session = await openComputerViewSession(user.id, id, mode, {
      handoff,
      fallbackOrigin,
      deviceSessionId,
      agentName: agent.name,
    });

    // A link is a promise of control, not control: the takeover starts, and
    // is recorded, when the link is opened (POST /api/computer-view/session).
    if (mode === "control" && session.kind === "direct") {
      await recordAgentEvent({
        userId: user.id,
        agentId: id,
        kind: "takeover_started",
        title: "Took over computer",
        detail: { via: deviceSessionId ? "app" : "web" },
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
        // A new take over: whether the agent's processes were paused.
        ...(session.freeze ? { freeze: session.freeze } : {}),
      },
      { headers: VIEW_HEADERS }
    );
  } catch (err) {
    if (err instanceof AsleepComputerError) {
      return NextResponse.json(
        { error: "asleep", message: "The computer is asleep. Wake it first." },
        { status: 409, headers: VIEW_HEADERS }
      );
    }
    if (err instanceof TakeoverHeldElsewhereError) {
      // A sentence and nothing else: no relay token, no password, no link.
      return NextResponse.json({ error: "held_elsewhere", message: err.message }, { status: 409, headers: VIEW_HEADERS });
    }
    const { status, body } = computerErrorBody(err, { fallbackError: "view_failed" });
    return NextResponse.json(body, { status, headers: VIEW_HEADERS });
  }
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";
import { findAgent } from "@/lib/agents/store";
import { getCurrentDeviceSessionId } from "@/lib/session";
import { takeoverHolder } from "@/lib/computer/takeover";
import { isAgentTeachConfigured } from "@/lib/env";
import { TeachError } from "@/lib/teach/service";

export const runtime = "nodejs";

/*
 * Teach by demonstration (docs/design/agents-v2/TEACH.md), behind
 * AGENT_TEACH_ENABLED=1.
 *
 *   GET   → { teach: { enabled, recording, latest } }
 *   POST  { action: "start" }                       starts recording the take over this client holds
 *   POST  { action: "stop" }                        stops it; answers what was recorded
 *   POST  { action: "discard", demonstrationId }    erases a recording
 *
 * The agent and the take over's holder come from the session, never the body.
 */

type Params = { params: Promise<{ id: string }> };

const HEADERS = { "Cache-Control": "no-store" } as const;

const bodySchema = z.object({
  action: z.enum(["start", "stop", "discard"]),
  demonstrationId: z.string().trim().min(1).max(64).optional(),
});

function refused(error: unknown) {
  if (error instanceof TeachError) {
    return NextResponse.json({ error: `teach_${error.code}`, message: error.message }, { status: error.status, headers: HEADERS });
  }
  return NextResponse.json(
    { error: "teach_failed", message: "Couldn’t do that right now. Try again in a moment." },
    { status: 500, headers: HEADERS }
  );
}

export async function GET(_req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;
  if (!isAgentTeachConfigured()) {
    return NextResponse.json({ teach: { enabled: false, recording: null, latest: null } }, { headers: HEADERS });
  }
  const agent = await findAgent(user.id, id);
  if (!agent) {
    return NextResponse.json({ error: "not_found", message: "That agent no longer exists." }, { status: 404, headers: HEADERS });
  }
  const { teachService } = await import("@/lib/teach/server");
  try {
    return NextResponse.json({ teach: await teachService().status(user.id, agent.id) }, { headers: HEADERS });
  } catch (err) {
    return refused(err);
  }
}

export async function POST(req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;
  if (!isAgentTeachConfigured()) {
    return NextResponse.json({ error: "teach_off", message: "Teaching by showing isn’t turned on for this server." }, { status: 404, headers: HEADERS });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input", message: "That request couldn’t be read." }, { status: 400, headers: HEADERS });
  }
  const limit = await rateLimit({ key: `agents:computer-teach:${user.id}:${id}`, limit: 60, windowSec: 3600 });
  if (!limit.success) {
    return NextResponse.json({ error: "rate_limited", message: "Too many requests. Try again shortly." }, { status: 429, headers: HEADERS });
  }
  const agent = await findAgent(user.id, id);
  if (!agent) {
    return NextResponse.json({ error: "not_found", message: "That agent no longer exists." }, { status: 404, headers: HEADERS });
  }

  const { teachService } = await import("@/lib/teach/server");
  const service = teachService();
  try {
    const { action, demonstrationId } = parsed.data;
    if (action === "start") {
      const holder = takeoverHolder(await getCurrentDeviceSessionId());
      return NextResponse.json({ demonstration: await service.start(user.id, agent.id, holder) }, { headers: HEADERS });
    }
    if (action === "stop") {
      return NextResponse.json({ demonstration: await service.stop(user.id, agent.id, "stopped") }, { headers: HEADERS });
    }
    if (!demonstrationId) {
      return NextResponse.json({ error: "invalid_input", message: "Say which recording to discard." }, { status: 400, headers: HEADERS });
    }
    await service.discard(user.id, agent.id, demonstrationId);
    return NextResponse.json({ discarded: true }, { headers: HEADERS });
  } catch (err) {
    return refused(err);
  }
}

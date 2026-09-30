import { NextResponse } from "next/server";
import { z } from "zod";
import { rateLimit } from "@/lib/rate-limit";
import { findAgent, recordAgentEvent } from "@/lib/agents/store";
import { exchangeComputerHandoffTicket } from "@/lib/computer/handoff";
import { isAgentComputerConfigured } from "@/lib/computer/provider";
import { AsleepComputerError, openComputerViewSession } from "@/lib/computer/store";

export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } as const;

const bodySchema = z.object({ ticket: z.string().trim().min(1).max(100) });

/**
 * The second half of an app's computer link (src/lib/computer/handoff.ts).
 *
 * The `/computer-view` page spent the link and gave its viewer a one-time
 * ticket; the viewer trades it here, once, for the relay token and the VNC
 * password. They travel in this response body, never in a page or a URL. No
 * session is needed or read: the ticket is the authorization, it is single-use,
 * it lives 60 seconds, and it is refused if the device session that asked for
 * the link has been revoked since.
 *
 * Control through a link is a takeover like any other: it opens the takeover
 * (the agent stops using the computer) and is recorded as `takeover_started`.
 */
export async function POST(req: Request) {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const limit = await rateLimit({ key: `computer-view:exchange:${forwarded}`, limit: 30, windowSec: 60 });
  if (!limit.success) {
    return NextResponse.json({ error: "rate_limited", message: "Too many requests. Try again shortly." }, { status: 429, headers: HEADERS });
  }
  if (!(await isAgentComputerConfigured())) {
    return NextResponse.json({ error: "not_found", message: "This link has expired." }, { status: 404, headers: HEADERS });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input", message: "This link has expired." }, { status: 400, headers: HEADERS });
  }

  const grant = await exchangeComputerHandoffTicket(parsed.data.ticket);
  if (!grant) {
    return NextResponse.json(
      { error: "expired", message: "This link has already been used or has expired. Open the computer again from the app." },
      { status: 410, headers: HEADERS }
    );
  }
  const agent = await findAgent(grant.userId, grant.agentId);
  if (!agent) {
    return NextResponse.json({ error: "not_found", message: "That crew member no longer exists." }, { status: 404, headers: HEADERS });
  }

  try {
    const session = await openComputerViewSession(grant.userId, grant.agentId, grant.mode, {
      deviceSessionId: grant.deviceSessionId,
    });
    if (session.kind !== "direct") throw new Error("unexpected handoff");
    if (grant.mode === "control") {
      await recordAgentEvent({
        userId: grant.userId,
        agentId: grant.agentId,
        kind: "takeover_started",
        title: "Took over computer",
        detail: { via: "app_link" },
      });
    }
    return NextResponse.json(
      { mode: session.mode, relayUrl: session.relayUrl, token: session.token, password: session.password },
      { headers: HEADERS }
    );
  } catch (err) {
    if (err instanceof AsleepComputerError) {
      return NextResponse.json({ error: "asleep", message: "The computer is asleep. Wake it from the app." }, { status: 409, headers: HEADERS });
    }
    return NextResponse.json({ error: "view_failed", message: "Unable to open the computer." }, { status: 409, headers: HEADERS });
  }
}

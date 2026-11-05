import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/code-remote";
import { findAgent } from "@/lib/agents/store";
import { channelProvider } from "@/lib/channels/config";
import { startLink } from "@/lib/channels/link";
import { linkDeps } from "@/lib/channels/store";

export const runtime = "nodejs";

const schema = z.object({
  phone: z.string().min(1).max(40),
  /** The agent a text without an @Name reaches; the first active agent when absent. */
  defaultAgentId: z.string().min(1).max(64).nullish(),
});

/**
 * Starts linking a number: texts it a six-digit code by iMessage. Only the
 * code's HMAC is kept, for ten minutes (src/lib/channels/link.ts). Rate
 * limited per account and per number, since each call texts a phone.
 */
export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const provider = channelProvider();
  if (!provider) return NextResponse.json({ error: "not_configured", message: "iMessage is not set up on this server." }, { status: 404 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input", message: "Enter the number with its country code." }, { status: 400 });
  }
  const defaultAgentId = parsed.data.defaultAgentId ?? null;
  if (defaultAgentId && !(await findAgent(user.id, defaultAgentId))) {
    return NextResponse.json({ error: "agent_not_found", message: "That agent is not one of yours." }, { status: 404 });
  }
  try {
    const outcome = await startLink(user.id, { phone: parsed.data.phone, defaultAgentId }, linkDeps(provider));
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch {
    console.error("[channels] link start failed");
    return NextResponse.json({ error: "link_failed", message: "The code could not be sent. Try again." }, { status: 500 });
  }
}

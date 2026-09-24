import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";
import { createAgentSchema } from "@/lib/agents/domain";
import { createAgentForUser, listAgentsForUser } from "@/lib/agents/store";

export const runtime = "nodejs";

/** The roster: every agent the account keeps, with its derived state. */
export async function GET() {
  const { user, error } = await requireUser();
  if (!user) return error;
  const agents = await listAgentsForUser(user.id);
  return NextResponse.json({ agents });
}

/** Hires an agent: the agent, its thread, and its first goal when one was given. */
export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;

  // Hiring is rare; a burst of them is a script. The cap on how many an account
  // keeps is `MAX_AGENTS_PER_ACCOUNT`; this is only the pace.
  const limit = await rateLimit({ key: `agents:create:${user.id}`, limit: 20, windowSec: 3600 });
  if (!limit.success) {
    return NextResponse.json(
      { error: "rate_limited", message: "That is a lot of new agents at once. Try again in a little while." },
      { status: 429 }
    );
  }

  const parsed = createAgentSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input", message: "That agent could not be read." }, { status: 400 });
  }
  const result = await createAgentForUser(user, parsed.data);
  return NextResponse.json(result.body, { status: result.status });
}

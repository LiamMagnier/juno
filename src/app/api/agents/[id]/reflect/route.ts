import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";
import { reflectAgent } from "@/lib/agents/reflect";

export const runtime = "nodejs";

/**
 * Asks the agent to reflect: ideas, goal check-ins, a note or two.
 *
 * Without `force` this is the lazy trigger the agent's page fires on open, and
 * it is a no-op until the six-hour interval has passed. With `force` it is the
 * person pressing "Think it over", paced by the rate limit rather than the
 * interval.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { force?: unknown } | null;
  const force = body?.force === true;
  if (force) {
    const limit = await rateLimit({ key: `agents:reflect:${user.id}`, limit: 12, windowSec: 3600 });
    if (!limit.success) {
      return NextResponse.json(
        { error: "rate_limited", message: "Your agents have thought a lot this hour. Try again a little later." },
        { status: 429 }
      );
    }
  }
  const outcome = await reflectAgent(user, id, { force });
  if (outcome.kind === "skipped" && outcome.reason === "not_found") {
    return NextResponse.json({ error: "not_found", message: "That agent no longer exists." }, { status: 404 });
  }
  return NextResponse.json({ outcome });
}

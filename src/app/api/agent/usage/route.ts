import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getUserPlan, consumeMessage, recordTokens } from "@/lib/usage";

export const runtime = "nodejs";

/**
 * Usage accounting for Juno Code. The desktop engine calls this so agent turns
 * draw against the same monthly plan as website chat:
 *
 *   { phase: "start" }
 *     → consumes one message from the plan (the same unit web chat charges).
 *       402 QUOTA_EXCEEDED when the monthly cap is reached, so a turn can't run.
 *
 *   { phase: "record", promptTokens, completionTokens, model }
 *     → adds the turn's real token counts to the period aggregate.
 *
 * A more specific route than /api/agent/[...path], so it wins over the proxy
 * catch-all. Auth is the shared session cookie the app already sends.
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { phase?: string; promptTokens?: number; completionTokens?: number; model?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const plan = await getUserPlan(user.id);

  if (body.phase === "start") {
    const consumed = await consumeMessage(user.id, plan);
    if (!consumed.allowed) {
      return NextResponse.json(
        {
          error: "You've reached your monthly usage limit. Upgrade your plan to keep using Juno Code.",
          code: "QUOTA_EXCEEDED",
          quota: consumed.quota,
        },
        { status: 402 },
      );
    }
    return NextResponse.json({ ok: true, quota: consumed.quota });
  }

  if (body.phase === "record") {
    await recordTokens(user.id, body.promptTokens ?? 0, body.completionTokens ?? 0);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown phase." }, { status: 400 });
}

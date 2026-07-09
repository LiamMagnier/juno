import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getUserPlan, consumeMessage, recordTokens, refundMessage } from "@/lib/usage";
import { checkBudget, budgetExceededMessage, recordSpend } from "@/lib/spend";

export const runtime = "nodejs";

/**
 * Usage accounting for Juno Code. The native/desktop engine calls this so
 * agent turns draw against the same plan limits as website chat:
 *
 *   { phase: "start" }
 *     → consumes one message from the plan AND checks the € budget — the
 *       message counter only blocks FREE (paid plans are budget-limited), so
 *       checkBudget is the gate that actually enforces paid-plan limits.
 *       402 QUOTA_EXCEEDED blocks the turn.
 *
 *   { phase: "record", promptTokens, completionTokens, model }
 *     → adds the turn's real token counts to the period aggregate AND writes
 *       an ApiSpend ledger row (kind "code", source "app") so app usage counts
 *       against the budget windows and shows up in the admin spending view.
 *
 *   { phase: "refund" }
 *     → gives back a reserved message when a turn produced no billable work
 *       (provider error / abort before output), mirroring the web chat route.
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
    const budget = await checkBudget(user.id, plan);
    if (!budget.allowed) {
      return NextResponse.json(
        { error: budgetExceededMessage(plan, budget.resetsAtMs), code: "QUOTA_EXCEEDED" },
        { status: 402 },
      );
    }
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
    const promptTokens = Math.max(0, Math.floor(body.promptTokens ?? 0));
    const completionTokens = Math.max(0, Math.floor(body.completionTokens ?? 0));
    await recordTokens(user.id, promptTokens, completionTokens);
    await recordSpend({
      userId: user.id,
      model: typeof body.model === "string" && body.model ? body.model : "unknown",
      kind: "code",
      source: "app",
      promptTokens,
      completionTokens,
    });
    return NextResponse.json({ ok: true });
  }

  if (body.phase === "refund") {
    const quota = await refundMessage(user.id, plan);
    return NextResponse.json({ ok: true, quota });
  }

  return NextResponse.json({ error: "Unknown phase." }, { status: 400 });
}

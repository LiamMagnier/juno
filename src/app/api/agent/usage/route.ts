import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import {
  getUserPlan,
  getQuota,
  recordTokens,
  reserveCodeMessage,
  resolveCodeUsageReservation,
} from "@/lib/usage";
import { checkBudget, budgetExceededMessage, recordSpend } from "@/lib/spend";

export const runtime = "nodejs";

const usageSchema = z.object({
  phase: z.enum(["start", "record", "refund"]),
  reservationId: z.string().min(1).max(100).optional(),
  promptTokens: z.number().int().min(0).max(10_000_000).optional(),
  completionTokens: z.number().int().min(0).max(10_000_000).optional(),
  model: z.string().trim().min(1).max(200).optional(),
});

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

  const parsed = usageSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const body = parsed.data;

  const plan = await getUserPlan(user.id);

  if (body.phase === "start") {
    const budget = await checkBudget(user.id, plan);
    if (!budget.allowed) {
      return NextResponse.json(
        { error: budgetExceededMessage(plan, budget.resetsAtMs), code: "QUOTA_EXCEEDED" },
        { status: 402 },
      );
    }
    const reserved = await reserveCodeMessage(user.id, plan);
    if (!reserved.allowed) {
      return NextResponse.json(
        {
          error: "You've reached your monthly usage limit. Upgrade your plan to keep using Juno Code.",
          code: "QUOTA_EXCEEDED",
          quota: reserved.quota,
        },
        { status: 402 },
      );
    }
    return NextResponse.json({
      ok: true,
      reservationId: reserved.reservationId,
      quota: reserved.quota,
    });
  }

  if (body.phase === "record") {
    if (!body.reservationId) {
      return NextResponse.json({ error: "A Code usage reservation is required." }, { status: 400 });
    }
    const resolution = await resolveCodeUsageReservation(user.id, body.reservationId, "recorded");
    if (resolution === "not_found" || resolution === "conflict") {
      return NextResponse.json({ error: "Invalid or already-resolved Code usage reservation." }, { status: 409 });
    }
    if (resolution === "already_resolved") return NextResponse.json({ ok: true, alreadyResolved: true });

    const promptTokens = body.promptTokens ?? 0;
    const completionTokens = body.completionTokens ?? 0;
    await recordTokens(user.id, promptTokens, completionTokens);
    await recordSpend({
      userId: user.id,
      model: body.model ?? "unknown",
      kind: "code",
      source: "app",
      promptTokens,
      completionTokens,
    });
    return NextResponse.json({ ok: true });
  }

  if (body.phase === "refund") {
    if (!body.reservationId) {
      return NextResponse.json({ error: "A Code usage reservation is required." }, { status: 400 });
    }
    const resolution = await resolveCodeUsageReservation(user.id, body.reservationId, "refunded");
    if (resolution === "not_found" || resolution === "conflict") {
      return NextResponse.json({ error: "Invalid or already-resolved Code usage reservation." }, { status: 409 });
    }
    return NextResponse.json({ ok: true, alreadyResolved: resolution === "already_resolved", quota: await getQuota(user.id, plan) });
  }

  return NextResponse.json({ error: "Unknown phase." }, { status: 400 });
}

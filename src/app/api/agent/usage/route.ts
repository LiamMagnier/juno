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
import { checkBudget, checkUsageWindows, budgetExceededMessage } from "@/lib/spend";
import { windowLimitMessage } from "@/lib/spend-ceiling";

export const runtime = "nodejs";

const usageSchema = z.object({
  phase: z.enum(["start", "record", "refund"]),
  reservationId: z.string().min(1).max(100).optional(),
  promptTokens: z.number().int().min(0).max(10_000_000).optional(),
  completionTokens: z.number().int().min(0).max(10_000_000).optional(),
  // Still accepted, because reporters still send it; nothing is priced from it
  // here since the proxy bills the calls (see "record" below).
  model: z.string().trim().min(1).max(200).optional(),
});

/**
 * Usage accounting for Juno Code. The native/desktop engine calls this so
 * agent turns draw against the same plan limits as website chat:
 *
 *   { phase: "start" }
 *     → consumes one message from the plan AND checks the € budget — the
 *       message counter only blocks FREE (paid plans are budget-limited), so
 *       checkBudget is the gate that actually enforces paid-plan limits,
 *       and `checkUsageWindows` beside it is the 5-hour/weekly one that is
 *       the real ceiling on a run. 402 QUOTA_EXCEEDED blocks the turn.
 *
 *   { phase: "record", promptTokens, completionTokens, model }
 *     → settles the reservation and adds the turn's token counts to the
 *       period aggregate. It does NOT write an ApiSpend row any more: every
 *       call these tokens describe went through the provider proxy
 *       (/api/agent/[...path]), which now bills each one from the provider's
 *       own usage, cache reads and writes included. A reporter only exists for
 *       backend-proxied providers (agent-core `usageReporterFor`), so there is
 *       no turn that reaches this phase without having been billed there. A
 *       second row here would charge the same tokens twice — from a client's
 *       own count, at the unknown-model rate, since reporters send a bare
 *       provider model id. The proxy's figure is the one to keep.
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
    // The rolling windows, for the same reason the proxy checks them: this is
    // the OTHER door into a Code turn — an agent-core host asks here before a
    // turn starts, then makes its calls through the proxy — so gating one and
    // not the other would leave the window enforced at only one of them. Same
    // 402 and same code, argued at the proxy.
    const windows = await checkUsageWindows(user.id, plan);
    if (!windows.allowed && windows.bound !== null) {
      return NextResponse.json(
        {
          error: windowLimitMessage(windows.bound, windows.resetsAtMs),
          code: "QUOTA_EXCEEDED",
          window: windows.bound,
          resetsAtMs: windows.resetsAtMs,
        },
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

    // The spend itself was billed by the proxy, call by call; see the header.
    await recordTokens(user.id, body.promptTokens ?? 0, body.completionTokens ?? 0);
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

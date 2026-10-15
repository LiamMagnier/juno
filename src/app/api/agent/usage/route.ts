import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import {
  consumeRefusalBody,
  getUserPlan,
  getQuota,
  openCodeUsageReservation,
  recordTokens,
  resolveCodeUsageReservation,
} from "@/lib/usage";
import { prisma } from "@/lib/prisma";
import { checkBudget, checkUsageWindows, budgetExceededMessage } from "@/lib/spend";
import { budgetExceededBody } from "@/lib/billing/budget-fallback";
import { windowLimitMessage } from "@/lib/spend-ceiling";
import { PRODUCT_NAME } from "@/lib/brand/names";

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
 *     → admits the turn the way a chat turn is admitted: an unconfirmed
 *       address is refused (`EMAIL_UNVERIFIED`), then the € budget and the
 *       5-hour/weekly windows, which are the real ceiling on a run. 402
 *       blocks the turn. It returns a single-use handle and does NOT move the
 *       month's message counter any more: the turn's opening call goes through
 *       the provider proxy, which counts the turn once that call is billed
 *       (src/lib/metering/code-turn-store.ts). Counting here as well would
 *       count every turn of these hosts twice.
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
 *     → closes the handle when a turn produced no billable work (provider
 *       error / abort before output). Nothing to give back: a turn whose
 *       opening was never billed was never counted.
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
    // The first thing `consumeMessage` asks of a chat turn, asked here too: an
    // address nobody confirmed does not get to spend on Code either.
    const account = await prisma.user.findUnique({ where: { id: user.id }, select: { emailVerified: true } });
    if (!account?.emailVerified) {
      return NextResponse.json(
        consumeRefusalBody({ allowed: false, reason: "email_unverified", quota: await getQuota(user.id, plan) }, "coding"),
        { status: 402 },
      );
    }
    const budget = await checkBudget(user.id, plan);
    if (!budget.allowed) {
      return NextResponse.json(
        budgetExceededBody(plan, budget.resetsAtMs, {
          error: budgetExceededMessage(plan, budget.resetsAtMs),
          code: "QUOTA_EXCEEDED",
        }),
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
    const quota = await getQuota(user.id, plan);
    if (quota.remaining !== null && quota.remaining <= 0) {
      return NextResponse.json(
        {
          error: `You've reached your monthly usage limit. Upgrade your plan to keep using ${PRODUCT_NAME} Code.`,
          code: "QUOTA_EXCEEDED",
          quota,
        },
        { status: 402 },
      );
    }
    const reservationId = await openCodeUsageReservation(user.id);
    return NextResponse.json({ ok: true, reservationId, quota });
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

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getUserPlan } from "@/lib/usage";
import { eurPerUsd } from "@/lib/spend";
import { creditSummary } from "@/lib/billing/credit-ledger";
import { TOP_UP_PACK_LIST, canBuyTopUp } from "@/lib/credits";
import { isStripeConfigured } from "@/lib/env";
import { purchasableTopUps } from "@/lib/stripe";

export const runtime = "nodejs";

/**
 * GET → the account's usage credit and the packs it may buy.
 *
 * { availableEur, nextExpiryMs, canBuy, packs: [{ id, htEur, creditEur }] }
 * Amounts are EUR of model budget (credit) or EUR HT (price); the client adds
 * VAT for display through price-display.ts.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const plan = await getUserPlan(user.id);
  const sellable = isStripeConfigured() ? purchasableTopUps() : [];
  let summary = { availableMicroUsd: 0, nextExpiryMs: null as number | null };
  try {
    summary = await creditSummary(user.id);
  } catch (err) {
    console.error("[credits] summary failed", { message: err instanceof Error ? err.message : String(err) });
  }
  const rate = eurPerUsd();
  return NextResponse.json({
    availableEur: Math.round((summary.availableMicroUsd / 1_000_000) * rate * 100) / 100,
    nextExpiryMs: summary.nextExpiryMs,
    canBuy: canBuyTopUp(plan) && sellable.length > 0,
    plan,
    packs: TOP_UP_PACK_LIST.filter((p) => sellable.includes(p.id)).map((p) => ({
      id: p.id,
      htEur: p.htEur,
      creditEur: p.creditEur,
    })),
  });
}

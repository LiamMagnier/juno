import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { env } from "@/lib/env";
import { getOrCreateReferralCode, referralStats } from "@/lib/billing/credit-ledger";
import { REFERRAL_CREDIT_EUR, REFERRAL_MAX_REWARDS } from "@/lib/credits";

export const runtime = "nodejs";

/**
 * GET → { code, link, rewarded, pending, rewardEur, maxRewards }.
 *
 * The code is minted on first ask. `rewarded` counts referred accounts whose
 * first paid subscription payment went through (each gave both sides
 * REFERRAL_CREDIT_EUR of usage); `pending` counts sign-ups that have not paid
 * yet.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const [code, stats] = await Promise.all([getOrCreateReferralCode(user.id), referralStats(user.id)]);
    return NextResponse.json({
      code,
      link: `${env.appUrl.replace(/\/$/, "")}/r/${code}`,
      rewarded: stats.rewarded,
      pending: stats.pending,
      rewardEur: REFERRAL_CREDIT_EUR,
      maxRewards: REFERRAL_MAX_REWARDS,
    });
  } catch (err) {
    console.error("[referrals] read failed", { message: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: "Referrals are unavailable right now." }, { status: 503 });
  }
}

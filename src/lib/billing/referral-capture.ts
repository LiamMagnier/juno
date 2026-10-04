import "server-only";
import { cookies } from "next/headers";
import { attachReferral } from "@/lib/billing/credit-ledger";
import { REFERRAL_COOKIE } from "@/lib/credits";

/**
 * Link a just-created account to the referral code it arrived with: an
 * explicit code (the sign-up form's `ref`) first, else the cookie set by
 * /r/<code> or a `?ref=` link. Best-effort: never throws, never blocks sign-up.
 */
export async function captureReferralAtSignUp(userId: string, explicitCode?: unknown): Promise<void> {
  try {
    let code: unknown = explicitCode;
    if (!code) {
      const jar = await cookies();
      code = jar.get(REFERRAL_COOKIE)?.value;
    }
    if (code) await attachReferral(userId, code);
  } catch (err) {
    console.warn("[referrals] capture skipped", { message: err instanceof Error ? err.message : String(err) });
  }
}

import { isOwnerEmail } from "@/lib/owner";
import { PLANS } from "@/lib/plans";
import { rateLimit } from "@/lib/rate-limit";
import { budgetExceededMessage, checkBudget } from "@/lib/spend";
import { getUserPlan } from "@/lib/usage";

export type VoiceAccessSurface = "relay-token" | "context" | "transcript";

export type VoiceAccessDenial = {
  status: 402 | 403 | 429;
  error: string;
  message?: string;
};

export type VoiceAccessDecision = {
  allowed: boolean;
  owner: boolean;
  plan: Awaited<ReturnType<typeof getUserPlan>>;
  denial?: VoiceAccessDenial;
};

const LIMITS: Record<VoiceAccessSurface, { limit: number; windowSec: number; message: string }> = {
  "relay-token": { limit: 30, windowSec: 60, message: "Slow down." },
  context: { limit: 120, windowSec: 3600, message: "Too many voice context requests. Try again later." },
  transcript: { limit: 30, windowSec: 3600, message: "Too many voice sessions. Try again later." },
};

/** One canonical decision for every user-authenticated Voice route. */
export async function evaluateVoiceAccess(
  user: { id: string; email?: string | null },
  surface: VoiceAccessSurface,
): Promise<VoiceAccessDecision> {
  const owner = isOwnerEmail(user.email);
  const plan = await getUserPlan(user.id);
  if (!owner && !PLANS[plan].voice) {
    return {
      allowed: false,
      owner,
      plan,
      denial: { status: 403, error: "Voice mode requires a paid plan." },
    };
  }
  if (owner) return { allowed: true, owner, plan };

  const policy = LIMITS[surface];
  const limit = await rateLimit({
    key: `voice-${surface}:${user.id}`,
    limit: policy.limit,
    windowSec: policy.windowSec,
  });
  if (!limit.success) {
    return {
      allowed: false,
      owner,
      plan,
      denial: { status: 429, error: policy.message },
    };
  }

  if (surface === "relay-token") {
    const budget = await checkBudget(user.id, plan);
    if (!budget.allowed) {
      return {
        allowed: false,
        owner,
        plan,
        denial: {
          status: 402,
          error: "budget_exceeded",
          message: budgetExceededMessage(plan, budget.resetsAtMs),
        },
      };
    }
  }
  return { allowed: true, owner, plan };
}

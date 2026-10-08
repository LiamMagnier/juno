import "server-only";

import type { Plan } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PLANS } from "@/lib/plans";
import { hasAnyActiveProviderKey } from "@/lib/code-v2/byok-store";

/**
 * Who may open Alevr Code (SPEC §2): a plan that includes it, OR someone who
 * brings their own inference — a stored API key, or a registered Mac where
 * their own subscriptions (Claude, Codex, ACP agents) run. Opening the
 * surface is all this decides. What actually spends Alevr's money stays gated
 * where the money is: POST /api/code/tasks refuses an Alevr-billed routing
 * without the plan, and /api/agent refuses an Alevr-key call without it.
 */
export type CodeAccess = { allowed: true; via: "plan" | "byok" | "device" } | { allowed: false };

export async function codeAccessFor(userId: string, plan: Plan): Promise<CodeAccess> {
  if (PLANS[plan].code) return { allowed: true, via: "plan" };
  if (await hasAnyActiveProviderKey(userId)) return { allowed: true, via: "byok" };
  const devices = await prisma.codeDevice.count({ where: { userId } });
  if (devices > 0) return { allowed: true, via: "device" };
  return { allowed: false };
}

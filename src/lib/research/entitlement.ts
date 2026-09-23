/**
 * Whether this person may start Research here at all (SPEC §9.1). Money and
 * concurrency — live runs, starts per day, the monthly share — are
 * `researchBudgetFor`'s answer, not this one.
 *
 * Pure: every input is a fact the caller already holds, so `/api/app`, the
 * chat route and `POST /api/research` answer the question the same way and a
 * test can walk the whole matrix.
 */

import type { Plan } from "@prisma/client";

import { PLANS } from "@/lib/plans";
import { workspacePermits, type WorkspaceConfig } from "@/lib/projects/workspace-config";
import { RESEARCH_PLAN_CAPS } from "@/lib/research/envelope";

export type ResearchRefusal =
  | "plan" | "not_configured" | "workspace" | "private" | "lockdown" | "voice"
  | "live_runs" | "daily_starts" | "budget";

/**
 * The order of the checks is the order of what a person can do about them:
 * a plan they can change, a deployment they cannot, then the surface they are
 * on. The first refusal found is the one they are told.
 */
export function researchEntitlement(input: {
  plan: Plan;
  privateMode: boolean;
  lockdown: boolean;
  voiceMode: boolean;
  workspace: WorkspaceConfig | null;        // workspacePermits(workspace, "deepResearch")
  configured: boolean;                       // isWebSearchConfigured()
}): { allowed: true } | { allowed: false; reason: ResearchRefusal } {
  if (!PLANS[input.plan].webSearch || !RESEARCH_PLAN_CAPS[input.plan].entitled) return { allowed: false, reason: "plan" };
  if (!input.configured) return { allowed: false, reason: "not_configured" };
  // A run is durable — rows, events, a completion message — and a private chat
  // leaves nothing behind (INV-32).
  if (input.privateMode) return { allowed: false, reason: "private" };
  // Lockdown stops reading the web, provider search and Research included (DECISIONS §4c).
  if (input.lockdown) return { allowed: false, reason: "lockdown" };
  if (input.voiceMode) return { allowed: false, reason: "voice" };
  if (input.workspace && !workspacePermits(input.workspace, "deepResearch")) return { allowed: false, reason: "workspace" };
  return { allowed: true };
}

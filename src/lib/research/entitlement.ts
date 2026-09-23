/**
 * Whether this person may start Research here at all (SPEC §9.1). Money and
 * concurrency — live runs, starts per day, the monthly share — are
 * `researchBudgetFor`'s answer, not this one.
 *
 * WS0 lands the signature; WS7 implements it.
 */

import type { Plan } from "@prisma/client";

import type { WorkspaceConfig } from "@/lib/projects/workspace-config";

export type ResearchRefusal =
  | "plan" | "not_configured" | "workspace" | "private" | "lockdown" | "voice"
  | "live_runs" | "daily_starts" | "budget";

export function researchEntitlement(_input: {
  plan: Plan;
  privateMode: boolean;
  lockdown: boolean;
  voiceMode: boolean;
  workspace: WorkspaceConfig | null;        // workspacePermits(workspace, "deepResearch")
  configured: boolean;                       // isWebSearchConfigured()
}): { allowed: true } | { allowed: false; reason: ResearchRefusal } {
  throw new Error("not implemented: WS7");
}

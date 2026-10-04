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
  if (!PLANS[input.plan].research || !PLANS[input.plan].webSearch || !RESEARCH_PLAN_CAPS[input.plan].entitled) return { allowed: false, reason: "plan" };
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

/**
 * What a person is told when Research is refused (SPEC §9.9): the legacy
 * warning row's title and one line per reason. Server strings a web client
 * can see, so none of them says "Deep" or names a depth. No number is
 * composed into a sentence (§10.1): the reset date, when there is one, is its
 * own phrase — `RESEARCH_REFUSAL_COPY.resetsOn` beside a formatted date.
 */
export const RESEARCH_REFUSAL_COPY = {
  skippedTitle: "Research was skipped",
  resetsOn: "Resets on",
  reasons: {
    plan: "Research is included from the Pro plan.",
    not_configured: "Research isn't set up on this server.",
    workspace: "This project doesn't allow Research.",
    private: "Research isn't available in private chats.",
    lockdown: "Research is off (Lockdown).",
    voice: "Research isn't available in voice mode.",
    live_runs: "Too many research runs are going. Wait for one to finish.",
    daily_starts: "You've reached today's research limit.",
    budget: "Research needs more of your usage window or monthly allowance than is left.",
  } satisfies Record<ResearchRefusal, string>,
} as const;

/**
 * The refusal as the chat's `research_skipped` notice and legacy warning row
 * carry it: the title, the reason's line, and the reset date as its own value
 * (ISO `yyyy-mm-dd`) when the refusal knows one.
 */
export function researchRefusalLine(
  reason: ResearchRefusal,
  params: Record<string, string | number> = {}
): { title: string; detail: string; resetsOn: string | null } {
  const resetsOn = typeof params.resetsOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(params.resetsOn) ? params.resetsOn : null;
  return { title: RESEARCH_REFUSAL_COPY.skippedTitle, detail: RESEARCH_REFUSAL_COPY.reasons[reason], resetsOn };
}

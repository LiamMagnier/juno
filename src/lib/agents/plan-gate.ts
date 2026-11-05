/**
 * Whether an account's plan may hire agents, as one rule the server and the
 * page both read.
 *
 * Agents are a Pro-and-up feature (`PLANS[plan].agents`). Before this, a Free
 * or Lite account could hire one (`createAgentForUser` never read the plan)
 * and then every task it started was refused with 402 at dispatch
 * (src/lib/work/dispatch.ts), so the person met the plan for the first time
 * in a thread, after setting the agent up. Now hiring is refused up front, on
 * the server, with the same honest upgrade sentence the page shows instead of
 * the hire field.
 *
 * Only hiring is gated. Agents an account already keeps (hired on a plan that
 * had them, before a downgrade) stay listed and readable; nothing here
 * deletes, pauses or hides them. Their tasks are still refused at dispatch,
 * which is where the money is.
 *
 * Pure and client-safe.
 */

import type { Plan } from "@prisma/client";
import { PLANS, cheapestPlanWith, planIncludes } from "@/lib/plans";

export interface AgentHiringGate {
  /** Whether this plan may hire (and duplicate) agents. */
  allowed: boolean;
  /** The account's plan, by name ("Free"). */
  planName: string;
  /** The cheapest plan that includes agents. */
  neededPlan: Plan;
  /** Its name ("Pro"). */
  neededPlanName: string;
  /** What the server says when it refuses, and what the page says instead of the field. Null when allowed. */
  message: string | null;
}

export function agentHiringGate(plan: Plan): AgentHiringGate {
  const needed = cheapestPlanWith("agents");
  const allowed = planIncludes(plan, "agents");
  return {
    allowed,
    planName: PLANS[plan].name,
    neededPlan: needed,
    neededPlanName: PLANS[needed].name,
    message: allowed
      ? null
      : `Agents are included from ${PLANS[needed].name}, and this account is on ${PLANS[plan].name}, so no agent was created. Upgrade to hire one. Agents you already have are kept.`,
  };
}

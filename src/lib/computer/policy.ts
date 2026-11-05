/**
 * Each agent's computer policy (docs/design/agents-v2/COMPUTERS_2026-10.md §S1.4):
 *
 *   off      its Work runs get no computer tools at all.
 *   ask      the first computer tool call of a run asks the person "Start
 *            {name}'s computer" (a sensitive Work approval); nothing starts
 *            without it. The default for new agents.
 *   allowed  the first computer tool call starts the computer on its own.
 *
 * Set by the person only: the panel, or a chat card the person approves. The
 * agent's own configuration tools can never raise it. Every change is
 * audited (`policy_changed`). The per-action floors do not change with it:
 * a shell command or typed text still asks every time once the computer is on.
 */

import { recordComputerAudit, type ComputerAuditActor } from "./audit";
import { COMPUTER_POLICY_LABEL, type ComputerPolicyValue } from "./access-copy";
import { parseComputerPolicy, readAgentComputerPolicy, writeAgentComputerPolicy } from "./store";

export type ComputerPolicy = ComputerPolicyValue;
export const COMPUTER_POLICIES: readonly ComputerPolicy[] = ["off", "ask", "allowed"];
export { COMPUTER_POLICY_LABEL, parseComputerPolicy };

/** How far a policy lets the agent go on its own: raising it widens what the agent may do. */
const POLICY_RANK: Record<ComputerPolicy, number> = { off: 0, ask: 1, allowed: 2 };

/** Whether moving from one policy to another widens what the agent may do (and so needs the person's approval in chat). */
export function raisesComputerPolicy(from: ComputerPolicy, to: ComputerPolicy): boolean {
  return POLICY_RANK[to] > POLICY_RANK[from];
}

export function isComputerPolicy(value: unknown): value is ComputerPolicy {
  return value === "off" || value === "ask" || value === "allowed";
}

/** The policy as stored now. `off` for an agent that is gone. */
export function readComputerPolicy(userId: string, agentId: string): Promise<ComputerPolicy> {
  return readAgentComputerPolicy(userId, agentId);
}

/**
 * Writes the policy and audits the change. Returns what it was and what it is
 * now, or null when there is no such agent. Writing the same value records
 * nothing.
 */
export async function setComputerPolicy(
  userId: string,
  agentId: string,
  policy: ComputerPolicy,
  actor: ComputerAuditActor,
): Promise<{ from: ComputerPolicy; to: ComputerPolicy } | null> {
  const before = await writeAgentComputerPolicy(userId, agentId, policy);
  if (before === null) return null;
  const from = parseComputerPolicy(before);
  if (from !== policy) {
    await recordComputerAudit({
      userId,
      agentId,
      kind: "policy_changed",
      actor,
      detail: { policyFrom: from, policyTo: policy },
    });
  }
  return { from, to: policy };
}

/**
 * What agents' computers say about access, allowance, the per-agent policy and
 * the start card (docs/design/agents-v2/COMPUTERS_2026-10.md §4.3).
 *
 * Every sentence here must stay true: a change in behaviour changes the
 * sentence in the same commit. Pure (no `server-only`) so the panel, the
 * routes, the runner and the tests read one table.
 */

import { PLANS } from "@/lib/plans";
import type { Plan } from "@prisma/client";

export const COMPUTER_ACCESS_COPY = {
  serverOff: "Computers aren’t available on this server.",
  unavailable: "Computers on this server can’t be reached right now. Try again in a few minutes.",
  rolloutOff: "Computers are switched off on this server right now.",
  notInRollout: "Computers are in early access and aren’t open to your account.",
  /** The plan refusal when no plan above the account's includes a computer (the owner's caps), so no upgrade is offered. */
  notInPlan: "Computers aren’t included in your plan.",
  /** The account's plan could not be read (a database error): a transient refusal, never a plan verdict. */
  accountUnchecked: "Your account couldn’t be checked just now. Try again in a few minutes.",
} as const;

/**
 * The panel's plan line: "Computers come with Pro and above." `andAbove` is
 * false when the owner's caps leave out a dearer plan, so the line names only
 * the plan it links to.
 */
export function panelPlanSentence(plan: Plan, andAbove = true): string {
  return `Computers come with ${PLANS[plan].name}${andAbove ? " and above" : ""}.`;
}

/** The API's 403 `plan` sentence. */
export function apiPlanSentence(plan: Plan, agentName: string, andAbove = true): string {
  return `Agent computers come with ${PLANS[plan].name}${andAbove ? " and above" : ""}. Upgrade to give ${agentName} a computer.`;
}

/** The API's 409 `enabled_cap` sentence. */
export function enabledCapSentence(maxEnabled: number, agentName: string): string {
  return `Your plan includes ${maxEnabled} agent computer${maxEnabled === 1 ? "" : "s"}, and all of them are in use. Delete one to give ${agentName} a computer.`;
}

/** "2 hours", "1 hour 30 minutes", "45 minutes". */
export function allowanceDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  const h = hours > 0 ? `${hours} hour${hours === 1 ? "" : "s"}` : "";
  const m = rest > 0 || hours === 0 ? `${rest} minute${rest === 1 ? "" : "s"}` : "";
  return [h, m].filter(Boolean).join(" ");
}

/** The 409 / tool `allowance_exhausted` sentence. */
export function allowanceSentence(weeklyMinutes: number): string {
  return `Your agents’ computers have used this week’s ${allowanceDuration(weeklyMinutes)}. They can start again on Monday at 00:00 UTC.`;
}

export type ComputerPolicyValue = "off" | "ask" | "allowed";

/** How a policy reads in a sentence. */
export const COMPUTER_POLICY_LABEL: Record<ComputerPolicyValue, string> = {
  off: "Off",
  ask: "Asks before starting",
  allowed: "Starts on its own",
};

/** The panel's segmented control. */
export const COMPUTER_POLICY_CONTROL_LABEL: Record<ComputerPolicyValue, string> = {
  off: "Off",
  ask: "Ask first",
  allowed: "On its own",
};

/** The start card's summary under `ask`. */
export function startApprovalSummary(agentName: string): string {
  return `Start ${agentName}’s computer`;
}

/** The start card's detail line: what the call would have done, asked for separately. */
export function startApprovalDetail(callSummary: string): string {
  return `What it wants to do next (asked separately): ${callSummary}`;
}

/** The approval explanation for `work.computer.start` (src/lib/work/domain.ts carries the same words). */
export const COMPUTER_START_EXPLANATION =
  "Starting the agent's computer uses this week's computer time. This agent is set to ask first, so starting asks every time. It approves nothing the computer does afterwards.";

/* Tool results the model reads. Plain apostrophes: they are prompts, not UI. */

export function startedResult(toolName: string): string {
  return `Started your computer. Nothing else was done: call ${toolName} again to do what you asked.`;
}

export const START_PENDING_RESULT =
  "Waiting for the person to start your computer. This call did not run; call it again once the computer has started.";

export const START_DECLINED_RESULT =
  "The person did not start your computer for this task. Carry on without it, or ask them with ask_user.";

export const POLICY_OFF_RESULT =
  "The person switched off your computer for tasks. Nothing was started. Carry on without it.";

export const POLICY_NOW_ASK_RESULT =
  "The person now wants to be asked before your computer starts. Call the tool again and they will be asked.";

export const BROWSER_NOW_COMPUTER_RESULT =
  "Your browser tool now uses your computer's browser, with its saved sign-ins. Pages from earlier in this task were in a temporary browser and are gone.";

export const PROMPT_ASK_LINES =
  "Your computer is off until you need it. The first time you use it in a task, the person is asked to start it; once it is on, repeat what you were doing.";

export const PROMPT_ASK_BROWSER_LINE =
  "Until your computer is on, the browser tool is a temporary browser with no sign-ins. To use your computer's signed-in browser, start your computer with a computer tool first.";

export const PROMPT_ASK_UNATTENDED_LINE =
  "Starting it needs the person's approval and this run waits for it, so use it only when the task needs it.";

export const COMPUTER_UNAVAILABLE_NOTE = "Your computer can't be reached right now; work without it.";

/** Said when the namespace check at wake failed (D13). */
export const WAKE_REFUSED_SANDBOX = "This computer failed a safety check, so it was not started.";

/** Said when the owner requires Chromium's own sandbox (AGENT_COMPUTER_REQUIRE_BROWSER_SANDBOX=1) and it is off. */
export const WAKE_REFUSED_SANDBOX_REQUIRED = "This server requires the browser's own sandbox, and this computer can't use it.";

/** The overlay's line once the agent's processes were paused for a take over. */
export function takeoverInfoLine(agentName: string): string {
  return `${agentName} is paused while you have control. Windows ${agentName} opened itself are closed; its commands carry on when you hand back.`;
}

/** The overlay's line when pausing the agent's processes failed. */
export function freezeFailedLine(agentName: string): string {
  return `Couldn’t pause what ${agentName} was running. It may still finish while you have control.`;
}

/** The chat tools' line when giving an agent a computer failed. */
export function chatComputerFailureLine(publicMessage: string): string {
  return `Computer: Not set up (${publicMessage})`;
}

/** The chat approval headlines for raising the policy (the existing "Give {name} its own computer?" stays for `computer: on`). */
export function chatPolicyHeadline(agentName: string, to: ComputerPolicyValue): string {
  return to === "allowed"
    ? `Let ${agentName} start its computer without asking?`
    : `Let ${agentName} ask to use a computer?`;
}

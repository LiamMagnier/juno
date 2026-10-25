/**
 * `propose_routine`: the chat model drafting a recurring routine for the person
 * to confirm.
 *
 * The model never creates a routine. It names the routine, writes what each run
 * does and says when in a phrase; this tool reads the phrase with the same
 * parser the routine editor uses, works out the next runs and a cost estimate,
 * and puts a card under the reply (`routineProposal` on a tool activity row).
 * The card's Schedule button is the only thing that writes a `WorkSchedule`,
 * through `POST /api/work/schedules` and every check that route makes.
 *
 * Two halves, like task-tool.ts: the declaration, the gate and the outcome
 * sentences are pure; `createProposeRoutineTool` reaches Prisma for the
 * account's connected apps through `await import()`.
 */

import type { Plan } from "@prisma/client";
import type { NativeChatTool } from "@/lib/tools/types";
import type { McpFunctionTool, ToolExecution } from "@/lib/mcp";
import type { ClientActivityEvent } from "@/types/chat";
import type { ToolPresentArgs } from "@/types/run";
import { PLANS } from "@/lib/plans";
import {
  MAX_PROPOSALS_PER_TURN,
  PROPOSE_ROUTINE_TOOL_ID,
  ROUTINE_PROPOSAL_REFUSALS,
  admitRoutineProposal,
  routineProposalKey,
  type ClientRoutineProposal,
  type RoutineProposalAdmission,
  type RoutineProposalApp,
} from "@/lib/work/routine-proposal";
import {
  PROPOSE_ROUTINE_DESCRIPTION,
  PROPOSE_ROUTINE_PARAMETERS,
  ROUTINE_OUTCOME_INSTRUCTIONS,
} from "@/lib/tools/specs/propose-routine.prompt";

export const ROUTINE_TOOL_LABEL = "Drafting a routine";

export const PROPOSE_ROUTINE_TOOL: McpFunctionTool = {
  type: "function",
  function: {
    name: PROPOSE_ROUTINE_TOOL_ID,
    description: PROPOSE_ROUTINE_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: PROPOSE_ROUTINE_PARAMETERS.name },
        instructions: { type: "string", description: PROPOSE_ROUTINE_PARAMETERS.instructions },
        schedule: { type: "string", description: PROPOSE_ROUTINE_PARAMETERS.schedule },
        timezone: { type: "string", description: PROPOSE_ROUTINE_PARAMETERS.timezone },
        apps: { type: "array", items: { type: "string" }, description: PROPOSE_ROUTINE_PARAMETERS.apps },
        maxCostUsd: { type: "number", description: PROPOSE_ROUTINE_PARAMETERS.maxCostUsd },
        notify: { type: "string", enum: ["on_finish", "on_attention"], description: PROPOSE_ROUTINE_PARAMETERS.notify },
      },
      required: ["name", "instructions", "schedule"],
    },
  },
};

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface RoutineToolGate {
  /** The client draws the proposal card: the web, or a native build that declares it. */
  clientDrawsProposal: boolean;
  privateMode: boolean;
  voiceMode: boolean;
  regenerate: boolean;
  userMessageId: string | null;
  researchActive: boolean;
  artifactEdit: boolean;
  conversationKind: string | null | undefined;
  /** An agent's own thread sets routines up with `propose_setup_change`. */
  agentThread: boolean;
  agenticTools: boolean;
  functionToolsReachModel: boolean;
  skillPermits: boolean;
  lockdown: boolean;
  /** A routine runs as Work, so the plan must be able to drive a Work run. */
  planHasWorkModel: boolean;
  plan?: Plan;
}

/**
 * Whether this turn carries `propose_routine`. The same conditions as
 * `start_task` (a routine is Work that repeats) plus a client that can draw
 * the card, and never in an agent's thread, where routines already go through
 * `propose_setup_change` with its own card and Undo.
 */
export function chatRoutineToolEnabled(gate: RoutineToolGate): boolean {
  return (
    gate.clientDrawsProposal &&
    !gate.privateMode &&
    !gate.voiceMode &&
    !gate.regenerate &&
    typeof gate.userMessageId === "string" &&
    gate.userMessageId.length > 0 &&
    !gate.researchActive &&
    !gate.artifactEdit &&
    gate.conversationKind === "chat" &&
    !gate.agentThread &&
    gate.agenticTools &&
    gate.functionToolsReachModel &&
    gate.skillPermits &&
    !gate.lockdown &&
    gate.planHasWorkModel &&
    (gate.plan === undefined || PLANS[gate.plan].agents)
  );
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** What the model and the thought-process panel are told about one call. */
export function describeRoutineOutcome(admission: RoutineProposalAdmission): ToolExecution {
  if (admission.ok) {
    const p = admission.proposal;
    return {
      text: JSON.stringify({
        status: "proposed",
        name: p.name,
        schedule: p.schedule.summary,
        timezone: p.timezone,
        ...(p.schedule.assumedTime ? { note: "No time was given, so it defaults to 09:00. The card says so." } : {}),
        ...(p.missingApps.length > 0 ? { notConnected: p.missingApps } : {}),
        instruction: ROUTINE_OUTCOME_INSTRUCTIONS.proposed,
      }),
      body: `Drafted "${p.name}": ${p.schedule.summary}.`,
      ok: true,
    };
  }
  return {
    text: JSON.stringify({
      status: "refused",
      reason: admission.reason,
      message: admission.message,
      instruction: ROUTINE_OUTCOME_INSTRUCTIONS.refused,
    }),
    body: admission.message,
    ok: false,
  };
}

/** The activity row the card rides on. */
export function routineProposalActivity(
  proposal: ClientRoutineProposal
): Omit<ClientActivityEvent, "id" | "createdAt"> {
  return { kind: "tool", title: "Drafted a routine", detail: proposal.name, routineProposal: proposal };
}

// ---------------------------------------------------------------------------
// The server half
// ---------------------------------------------------------------------------

const BRAND_LABELS: Record<string, string> = {
  gmail: "Gmail",
  googlecalendar: "Google Calendar",
  googledrive: "Google Drive",
  googledocs: "Google Docs",
  googlesheets: "Google Sheets",
  outlook: "Outlook",
  slack: "Slack",
  notion: "Notion",
  linear: "Linear",
  github: "GitHub",
  jira: "Jira",
  asana: "Asana",
};

function prettify(slug: string): string {
  const key = slug.toLowerCase().replace(/[^a-z0-9]/g, "");
  return BRAND_LABELS[key] ?? slug.split(/[_-]+/).filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ");
}

export interface RoutineToolContext {
  user: { id: string };
  userMessageId: string;
  /** `ChatRequestBody.timeZone`. */
  timeZone?: string | null;
  /** The apps enabled for this message, which are connected by definition. */
  activeConnectors: readonly RoutineProposalApp[];
  /** The model this conversation runs on, for the warning estimate. */
  model: string;
  untrustedContent: boolean;
  untrustedNow?: () => { untrusted: boolean; hostile?: boolean };
  /** Puts the card on screen (and in the message's activity log). */
  onProposal: (proposal: ClientRoutineProposal) => void;
  now?: () => Date;
}

/** Every app the account has connected, labelled, plus this message's. */
async function connectedApps(ctx: RoutineToolContext): Promise<RoutineProposalApp[]> {
  return connectedAppsFor(ctx.user.id, ctx.activeConnectors);
}

/**
 * Every app an account has connected, labelled, plus the ones enabled for this
 * message. Shared with `draft_skill` (src/lib/chat/skill-draft-tool.ts), which
 * matches a taught method's apps against the same list.
 */
export async function connectedAppsFor(
  userId: string,
  activeConnectors: readonly RoutineProposalApp[]
): Promise<RoutineProposalApp[]> {
  const apps = new Map<string, RoutineProposalApp>();
  for (const app of activeConnectors) apps.set(app.id, app);
  try {
    const [{ prisma }, connectors, composio] = await Promise.all([
      import("@/lib/prisma"),
      import("@/lib/connectors"),
      import("@/lib/composio"),
    ]);
    const rows = await prisma.connection.findMany({
      where: { userId },
      select: { provider: true },
      take: 100,
    });
    for (const row of rows) {
      if (apps.has(row.provider)) continue;
      const slug = composio.composioSlugFromId(row.provider);
      const label = slug ? prettify(slug) : connectors.getConnector(row.provider)?.label ?? prettify(row.provider);
      apps.set(row.provider, { id: row.provider, label });
    }
  } catch {
    // The card still works without the account's list: an app it cannot match
    // is listed as not connected, which the person can check in one press.
  }
  return [...apps.values()];
}

export function createProposeRoutineTool(ctx: RoutineToolContext): NativeChatTool {
  let proposed = 0;
  return {
    tool: PROPOSE_ROUTINE_TOOL,
    label: ROUTINE_TOOL_LABEL,
    // Creates nothing: the card's Schedule press is the write.
    access: "read",
    dedupe: true,
    present(args): ToolPresentArgs {
      const shown: ToolPresentArgs = {};
      if (typeof args.name === "string") shown.title = args.name.slice(0, 80);
      return shown;
    },
    async execute(args) {
      if (proposed >= MAX_PROPOSALS_PER_TURN) {
        return describeRoutineOutcome({ ok: false, reason: "too_many", message: ROUTINE_PROPOSAL_REFUSALS.too_many });
      }
      const taint = ctx.untrustedNow?.() ?? { untrusted: ctx.untrustedContent, hostile: false };
      const [{ estimateWorkRunCost }, apps] = await Promise.all([
        import("@/lib/work/preflight-cost"),
        connectedApps(ctx),
      ]);
      const admission = admitRoutineProposal(args, {
        key: routineProposalKey(ctx.userMessageId, proposed),
        now: ctx.now?.() ?? new Date(),
        defaultTimezone: ctx.timeZone,
        connectors: apps,
        untrusted: taint.untrusted || ctx.untrustedContent,
        hostile: taint.hostile === true,
        estimateCostMicroUsd: (instructions) => {
          try {
            return estimateWorkRunCost({ modelId: ctx.model, goalChars: instructions.length }).estimatedCostMicroUsd;
          } catch {
            return null;
          }
        },
      });
      if (admission.ok) {
        proposed += 1;
        ctx.onProposal(admission.proposal);
      }
      console.info("[chat:routine] propose_routine", {
        status: admission.ok ? "proposed" : "refused",
        ...(admission.ok ? { kind: admission.proposal.schedule.kind } : { reason: admission.reason }),
      });
      return describeRoutineOutcome(admission);
    },
  };
}

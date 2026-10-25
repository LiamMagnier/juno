/**
 * `draft_skill`: the chat model drafting a skill the person taught it, for the
 * person to review.
 *
 * The model never creates a skill. It names the method, writes the steps the
 * person showed or said, and says what the method needs; this tool checks the
 * draft (`admitSkillDraft`: bounds, the teachable tool list, the connected
 * apps, the skill scanner), notes which tools and apps this conversation
 * actually used, and puts a card under the reply (`skillDraft` on a tool
 * activity row). The card's Review opens the Teach page, and only a Save there
 * writes a `WorkSkill`, switched off unless the person confirms what it may use.
 *
 * Offered only when the person has said, in this message or one of the last
 * few, that they want to teach Juno something (`detectTeachIntent`). The tool
 * and its prompt section therefore cost nothing on an ordinary turn, and a
 * model cannot reach for it because a web page suggested saving a "skill".
 *
 * Two halves, like routine-tool.ts: the declaration, the gate, the intent
 * reading and the outcome sentences are pure; `createDraftSkillTool` reaches
 * Prisma for the account's apps and the conversation's tool history through
 * `await import()`, and both reads can be replaced in a test.
 */

import type { NativeChatTool } from "@/lib/tools/types";
import type { McpFunctionTool, ToolExecution } from "@/lib/mcp";
import type { ClientActivityEvent } from "@/types/chat";
import type { ToolPresentArgs } from "@/types/run";
import {
  DRAFT_SKILL_TOOL_ID,
  MAX_SKILL_DRAFTS_PER_TURN,
  SKILL_DRAFT_REFUSALS,
  admitSkillDraft,
  skillDraftKey,
  teachableToolId,
  type ClientSkillDraft,
  type SkillDraftAdmission,
  type TaughtApp,
} from "@/lib/skills/teach";
import {
  DRAFT_SKILL_DESCRIPTION,
  DRAFT_SKILL_PARAMETERS,
  SKILL_DRAFT_OUTCOME_INSTRUCTIONS,
} from "@/lib/tools/specs/draft-skill.prompt";

export const SKILL_DRAFT_TOOL_LABEL = "Drafting a skill";

export const DRAFT_SKILL_TOOL: McpFunctionTool = {
  type: "function",
  function: {
    name: DRAFT_SKILL_TOOL_ID,
    description: DRAFT_SKILL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: DRAFT_SKILL_PARAMETERS.name },
        whenToUse: { type: "string", description: DRAFT_SKILL_PARAMETERS.whenToUse },
        steps: { type: "array", items: { type: "string" }, description: DRAFT_SKILL_PARAMETERS.steps },
        inputs: {
          type: "array",
          description: DRAFT_SKILL_PARAMETERS.inputs,
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              description: { type: "string" },
              required: { type: "boolean" },
            },
            required: ["name"],
          },
        },
        doneWhen: { type: "string", description: DRAFT_SKILL_PARAMETERS.doneWhen },
        rules: { type: "array", items: { type: "string" }, description: DRAFT_SKILL_PARAMETERS.rules },
        tools: { type: "array", items: { type: "string" }, description: DRAFT_SKILL_PARAMETERS.tools },
        apps: { type: "array", items: { type: "string" }, description: DRAFT_SKILL_PARAMETERS.apps },
        questions: { type: "array", items: { type: "string" }, description: DRAFT_SKILL_PARAMETERS.questions },
      },
      required: ["name", "whenToUse", "steps"],
    },
  },
};

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

/** How many of the person's latest messages are read for teaching intent. */
export const TEACH_INTENT_LOOKBACK = 6;

/**
 * Phrases that mean "learn how I do this". English and French, the product's
 * two most used languages; a miss costs the person one rephrase or a press on
 * Skills → Teach, a false hit costs one tool definition on a turn.
 */
const TEACH_PATTERNS: readonly RegExp[] = [
  /\bteach(?:ing)?\s+(?:you|juno|alevr|it)\b/i,
  /\b(?:let me|i(?:'|’)ll|i will|i want to|i'd like to|going to)\s+show\s+you\s+how\b/i,
  /\bshow\s+you\s+how\s+i\b/i,
  /\b(?:turn|make|save|convert|keep|store|draft|create|write)\b.{0,60}\b(?:as|into|in)\s+(?:a\s+|an\s+)?(?:new\s+)?(?:skill|workflow|playbook|procedure)\b/i,
  /\b(?:new|draft|create|make|save|write)\s+(?:a\s+|an\s+|this\s+|that\s+)?(?:skill|workflow|playbook)\b/i,
  /\bremember\s+how\s+(?:i|we|to)\b/i,
  /\b(?:next|every)\s+time,?\s+(?:i\s+ask|you|do\s+it|do\s+this|follow)\b/i,
  /^\s*\/teach\b/i,
  // French
  /\b(?:je\s+(?:vais|veux)\s+t(?:'|’)apprendre|apprends?(?:-moi)?\s+(?:à|a)\s+faire|t(?:'|’)enseigner|te\s+montrer\s+comment)\b/i,
  /\b(?:cr[ée]e[rz]?|enregistre[rz]?|transforme[rz]?|fais|sauvegarde[rz]?)\b.{0,60}\b(?:comp[ée]tence|skill|proc[ée]dure|workflow)\b/i,
  /\b(?:la\s+prochaine\s+fois|à\s+chaque\s+fois)\b.{0,40}\b(?:fais|suis|procède)\b/i,
];

/** Whether any of the person's latest messages asks to teach Juno a method. */
export function detectTeachIntent(messages: readonly (string | null | undefined)[]): boolean {
  return messages
    .slice(-TEACH_INTENT_LOOKBACK)
    .some((message) => typeof message === "string" && TEACH_PATTERNS.some((pattern) => pattern.test(message.slice(0, 4_000))));
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface SkillDraftToolGate {
  /** The client draws the draft card: the web, for now. */
  clientDrawsProposal: boolean;
  privateMode: boolean;
  voiceMode: boolean;
  regenerate: boolean;
  userMessageId: string | null;
  researchActive: boolean;
  artifactEdit: boolean;
  conversationKind: string | null | undefined;
  agentThread: boolean;
  agenticTools: boolean;
  functionToolsReachModel: boolean;
  skillPermits: boolean;
  lockdown: boolean;
  /** `detectTeachIntent` over the person's latest messages. */
  teachIntent: boolean;
}

/**
 * Whether this turn carries `draft_skill`. A saved conversation (the draft's
 * provenance points at it and the card is persisted on its reply), a client
 * that draws the card, a model that calls tools, and the person having asked
 * to teach something. Never in incognito (nothing of it may be kept), on voice
 * (no card), in an agent's thread (its setup goes through its own card), in
 * lockdown, or when an armed skill does not list it.
 */
export function chatSkillDraftToolEnabled(gate: SkillDraftToolGate): boolean {
  return (
    gate.teachIntent &&
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
    !gate.lockdown
  );
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** What the model and the thought-process panel are told about one call. */
export function describeSkillDraftOutcome(admission: SkillDraftAdmission): ToolExecution {
  if (admission.ok) {
    const d = admission.draft;
    return {
      text: JSON.stringify({
        status: "proposed",
        name: d.name,
        steps: d.steps.length,
        ...(d.tools.length > 0 ? { tools: d.tools } : {}),
        ...(d.apps.length > 0 ? { apps: d.apps.map((app) => app.label) } : {}),
        ...(d.missingApps.length > 0 ? { notConnected: d.missingApps } : {}),
        ...(d.dropped.length > 0 ? { notAvailableToSkills: d.dropped } : {}),
        instruction: SKILL_DRAFT_OUTCOME_INSTRUCTIONS.proposed,
      }),
      body: `Drafted "${d.name}": ${d.steps.length} step${d.steps.length === 1 ? "" : "s"}.`,
      ok: true,
    };
  }
  return {
    text: JSON.stringify({
      status: "refused",
      reason: admission.reason,
      message: admission.message,
      instruction: SKILL_DRAFT_OUTCOME_INSTRUCTIONS.refused,
    }),
    body: admission.message,
    ok: false,
  };
}

/** The activity row the card rides on. */
export function skillDraftActivity(draft: ClientSkillDraft): Omit<ClientActivityEvent, "id" | "createdAt"> {
  return { kind: "tool", title: "Drafted a skill", detail: draft.name, skillDraft: draft };
}

// ---------------------------------------------------------------------------
// What the conversation used
// ---------------------------------------------------------------------------

/**
 * The teachable tools and connected apps a conversation's activity rows show
 * it used: a search row is web search, a visit is opening a page, an artifact
 * is the canvas, and a tool row is its own name (or, for a connector call, the
 * app whose label it carries). Only calls that did not fail count.
 */
export function observedFromActivity(
  events: readonly unknown[],
  apps: readonly TaughtApp[]
): { tools: string[]; apps: string[] } {
  const tools = new Set<string>();
  const used = new Set<string>();
  const byLabel = new Map(apps.map((app) => [app.label.toLowerCase(), app.id]));
  for (const raw of events) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const event = raw as Record<string, unknown>;
    if (event.kind === "search") tools.add("web_search");
    else if (event.kind === "visit") tools.add("web_fetch");
    else if (event.kind === "artifact") tools.add("canvas");
    else if (event.kind === "tool" && event.tool && typeof event.tool === "object") {
      const tool = event.tool as Record<string, unknown>;
      if (tool.status === "failed") continue;
      const name = typeof tool.name === "string" ? tool.name : "";
      const server = typeof tool.server === "string" ? tool.server : "";
      const id = name && !name.includes("__") ? teachableToolId(name) : null;
      if (id) tools.add(id);
      else if (server && byLabel.has(server.toLowerCase())) used.add(byLabel.get(server.toLowerCase())!);
    }
  }
  return { tools: [...tools], apps: [...used] };
}

// ---------------------------------------------------------------------------
// The server half
// ---------------------------------------------------------------------------

/** How many of the conversation's latest replies are read for tool history. */
const OBSERVED_REPLIES = 30;

async function defaultConnectedApps(userId: string, active: readonly TaughtApp[]): Promise<TaughtApp[]> {
  const { connectedAppsFor } = await import("@/lib/chat/routine-tool");
  return connectedAppsFor(userId, active);
}

async function defaultObserved(
  userId: string,
  conversationId: string,
  apps: readonly TaughtApp[]
): Promise<{ tools: string[]; apps: string[] }> {
  try {
    const [{ prisma }, { decryptJsonField }] = await Promise.all([import("@/lib/prisma"), import("@/lib/field-crypto")]);
    const rows = await prisma.message.findMany({
      where: { conversationId, role: "ASSISTANT", conversation: { userId } },
      orderBy: { createdAt: "desc" },
      take: OBSERVED_REPLIES,
      select: { activity: true },
    });
    const events = rows.flatMap((row) => {
      const activity = decryptJsonField(row.activity);
      return Array.isArray(activity) ? activity : [];
    });
    return observedFromActivity(events, apps);
  } catch {
    // Evidence, not a requirement: without it the card simply cannot say
    // "used in this chat" next to anything.
    return { tools: [], apps: [] };
  }
}

/**
 * A live reading of a turn's taint, for `untrustedNow`, or undefined when the
 * turn keeps none.
 *
 * What it covers, precisely: the saved chat path's `TurnTaint` is the one
 * Alevr Search's tools carry (`createAlevrSearchTurn`), marked by its search
 * and page reads as they happen, `hostile` included when a fetched page reads
 * as an injection. Connector results and the provider's own web search do not
 * mark it on this path, so a hostile page reached through them is not refused
 * here; the draft is still marked `fromOutsideContent` whenever web search or
 * an app is on, because the static `untrustedContent` flag covers both.
 */
export function turnTaintReader(
  taint: { readonly observed: boolean; readonly severity: string } | null | undefined
): (() => { untrusted: boolean; hostile: boolean }) | undefined {
  if (!taint) return undefined;
  return () => ({ untrusted: taint.observed, hostile: taint.severity === "hostile" });
}

export interface SkillDraftToolContext {
  user: { id: string };
  userMessageId: string;
  conversationId: string;
  /** The apps enabled for this message, which are connected by definition. */
  activeConnectors: readonly TaughtApp[];
  /** Outside content could be in this turn (the static reading, decided before the first token). */
  untrustedContent: boolean;
  /** The turn's taint as it stands at call time (`turnTaintReader`); absent, only the static flag is read. */
  untrustedNow?: () => { untrusted: boolean; hostile?: boolean };
  /** Puts the card on screen (and in the message's activity log). */
  onDraft: (draft: ClientSkillDraft) => void;
  now?: () => Date;
  /** Replaceable in tests; default reads the account's connections. */
  connectedApps?: (userId: string, active: readonly TaughtApp[]) => Promise<TaughtApp[]>;
  /** Replaceable in tests; default reads this conversation's earlier replies. */
  observed?: (userId: string, conversationId: string, apps: readonly TaughtApp[]) => Promise<{ tools: string[]; apps: string[] }>;
}

export function createDraftSkillTool(ctx: SkillDraftToolContext): NativeChatTool {
  let drafted = 0;
  return {
    tool: DRAFT_SKILL_TOOL,
    label: SKILL_DRAFT_TOOL_LABEL,
    // Creates nothing: the Teach page's Save is the write.
    access: "read",
    dedupe: true,
    present(args): ToolPresentArgs {
      const shown: ToolPresentArgs = {};
      if (typeof args.name === "string") shown.title = args.name.slice(0, 80);
      return shown;
    },
    async execute(args) {
      if (drafted >= MAX_SKILL_DRAFTS_PER_TURN) {
        return describeSkillDraftOutcome({ ok: false, reason: "too_many", message: SKILL_DRAFT_REFUSALS.too_many });
      }
      const taint = ctx.untrustedNow?.() ?? { untrusted: ctx.untrustedContent, hostile: false };
      const apps = await (ctx.connectedApps ?? defaultConnectedApps)(ctx.user.id, ctx.activeConnectors).catch(
        () => [...ctx.activeConnectors]
      );
      const observed = await (ctx.observed ?? defaultObserved)(ctx.user.id, ctx.conversationId, apps).catch(() => ({
        tools: [],
        apps: [],
      }));
      const admission = admitSkillDraft(args, {
        key: skillDraftKey(ctx.userMessageId, drafted),
        now: ctx.now?.() ?? new Date(),
        conversationId: ctx.conversationId,
        connectors: apps,
        observed,
        untrusted: taint.untrusted || ctx.untrustedContent,
        hostile: taint.hostile === true,
      });
      if (admission.ok) {
        drafted += 1;
        ctx.onDraft(admission.draft);
      }
      console.info("[chat:teach] draft_skill", {
        status: admission.ok ? "proposed" : "refused",
        ...(admission.ok ? { steps: admission.draft.steps.length } : { reason: admission.reason }),
      });
      return describeSkillDraftOutcome(admission);
    },
  };
}

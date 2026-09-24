/**
 * Which tools a chat turn carries (SPEC §3.6): one pure function in place of
 * the route's and the skill layer's copies. The composer does not call it —
 * its inputs are server facts — and reads `/api/app` features instead.
 *
 * The matrix, row by row (DECISIONS T3, §4c; gap-entitlements §2):
 *
 * - Provider search where the model has it on Juno's transport, else Juno's
 *   own `web_search` when a keyed engine is configured (RC-2: every
 *   tools-capable model can search), and `web_fetch` whenever web is on.
 * - The attachment readers ride their attachments, as before; `run_code` needs
 *   a sandbox confirmed to have no network, and an unrestricted workspace.
 * - `search_chats` on saved turns; `current_time` and `calculate` everywhere
 *   a model takes tools, private chats and lockdown included.
 * - FREE: the readers, the pure tools and `search_chats`; no web, code,
 *   connectors, tasks or research. Private: only the pure tools, and web when
 *   toggled on in that chat. Lockdown or the `block` policy: only the pure
 *   tools, and no provider search either. Voice: unchanged.
 * - A skill that lists tools narrows every row, provider search and the pure
 *   tools included. An artifact edit carries no tools.
 */

import type { Plan } from "@prisma/client";

import type { ActionPermissionPolicy } from "@/lib/action-approval";
import type { ClientFeatureSet } from "@/lib/chat/client-features";
import type { ChatSkillApplication } from "@/lib/chat/skills";
import { roundBudgetFor } from "@/lib/llm/loop";
import { toolCapabilitiesFor } from "@/lib/model-tools";
import type { ModelInfo } from "@/lib/models";
import { PLANS } from "@/lib/plans";
import { workspacePermits, type WorkspaceConfig } from "@/lib/projects/workspace-config";
import { canonicalToolId } from "@/lib/tools/aliases";
import { JUNO_TOOL_IDS } from "@/lib/tools/registry";
import type { JunoToolId } from "@/lib/tools/types";
import type { ReasoningEffort } from "@/types/chat";
import type { RunNoticeCode } from "@/types/run";

export interface EntitlementInput {
  plan: Plan;
  private: boolean;
  lockdown: boolean;
  approvalPolicy: ActionPermissionPolicy;
  voice: boolean;
  regenerate: boolean;
  artifactEdit: boolean;
  researchActive: boolean;          // research runs this turn (native in-chat path)
  researchArmed: boolean;           // the user armed Research on this send (any path)
  webToggle: boolean;               // input.webSearch === true (private: the per-chat toggle)
  features: ClientFeatureSet;
  workspace: WorkspaceConfig;
  skill: ChatSkillApplication | null;
  model: ModelInfo;                 // read through toolCapabilitiesFor (SPEC §5.6)
  hasFileAttachment: boolean;
  hasInspectable: boolean;
  sandboxConfigured: boolean;       // isCodeInterpreterConfigured() AND egress isolation confirmed
  keyedSearchEngine: boolean;       // at least one of Tavily/Serper/Brave/Exa configured
  saved: { userMessageId: string | null; conversationKind: "chat" | "code" } | null;
  taskTool: boolean;                // chatTaskToolEnabled(...), computed by the caller
  /**
   * The turn's effective effort after Auto and clamping. Sizes the round
   * budget (SPEC §4.1) and keeps hosted search off at `minimal` on a model
   * that rejects it there. Absent reads as the default budget.
   */
  effort?: ReasoningEffort | null;
  /**
   * `researchEntitlement(...).allowed` (SPEC §9.1), computed by the caller.
   * Absent: derived from the plan, private, lockdown, voice and the workspace,
   * which is that function without its "a search backend is configured" half.
   */
  researchEntitled?: boolean;
  /** The request named connectors. Only read to tell a private chat why it has none. */
  connectorsRequested?: boolean;
}

export interface ChatToolPlan {
  juno: JunoToolId[];
  nativeSearch: boolean;            // provider search attached (Anthropic, Gemini, OpenAI/xAI Responses)
  connectors: boolean;
  suggestResearch: boolean;
  roundBudget: number;              // SPEC §4.1
  notices: RunNoticeCode[];
  /** Web nudge variant for the system prompt: numbered [n] or markdown links. */
  citationStyle: "numbered" | "links";
}

/**
 * The names a skill's tool list narrows by, canonicalised: a skill written
 * for `code_interpreter` or `browser_agent` still means `run_code` and
 * `web_fetch` (INV-23). Null when the skill lists no tools, which narrows
 * nothing — an empty list is the common shape, not "this skill wants none".
 */
function skillToolNames(skill: ChatSkillApplication | null): ReadonlySet<string> | null {
  if (!skill) return null;
  const requested = [...skill.resolved.tools, ...skill.resolved.withheld.tools];
  if (requested.length === 0) return null;
  return new Set(requested.map(canonicalToolId));
}

/** The research entitlement without its backend check (SPEC §9.1), when the caller gave none. */
function derivedResearchEntitled(input: EntitlementInput): boolean {
  return (
    PLANS[input.plan].webSearch &&
    input.plan !== "FREE" &&
    !input.private &&
    !input.lockdown &&
    !input.voice &&
    workspacePermits(input.workspace, "deepResearch")
  );
}

export function chatToolEntitlements(input: EntitlementInput): ChatToolPlan {
  const caps = toolCapabilitiesFor(input.model);
  const roundBudget = roundBudgetFor(input.effort, input.voice);
  const notices: RunNoticeCode[] = [];
  if (input.lockdown && input.webToggle) notices.push("web_off_lockdown");
  if (input.private && input.connectorsRequested) notices.push("private_tools_limited");

  // An artifact edit is a rewrite of one artifact, never a turn that reaches out.
  if (input.artifactEdit) {
    return { juno: [], nativeSearch: false, connectors: false, suggestResearch: false, roundBudget, notices, citationStyle: "links" };
  }

  const functions = caps.supported && input.model.modality === "chat";
  const blocked = input.lockdown || input.approvalPolicy === "block";
  const paid = input.plan !== "FREE";
  const skillNames = skillToolNames(input.skill);
  const skillAllows = (name: string) => !skillNames || skillNames.has(name);
  const webWorkspace = workspacePermits(input.workspace, "webSearch");
  // Web at all: the toggle (in a private chat, that chat's own toggle), a plan
  // with web, no lockdown, a workspace that allows it, and no in-chat research
  // run supplying its own corpus this turn.
  const web = input.webToggle && PLANS[input.plan].webSearch && !blocked && webWorkspace && !input.researchActive;

  const minimalBlocksHosted = input.effort === "minimal" && !!caps.hostedSearchMinEffort;
  const nativeSearch = web && caps.nativeSearch && !minimalBlocksHosted && skillAllows("web_search");

  const attached = new Set<JunoToolId>();
  if (functions) {
    // Juno's own search only where the provider's is not attached this turn.
    if (web && !nativeSearch && input.keyedSearchEngine && !input.voice && skillAllows("web_search")) {
      attached.add("web_search");
    }
    // Voice keeps the page reader only where it had one before: web on and a
    // model with provider search.
    if (web && skillAllows("web_fetch") && (!input.voice || caps.nativeSearch)) attached.add("web_fetch");

    if (!input.private && !blocked) {
      if (input.hasFileAttachment && skillAllows("read_document")) attached.add("read_document");
      if (input.hasInspectable && input.model.vision && skillAllows("inspect_image")) attached.add("inspect_image");
      if (
        input.sandboxConfigured &&
        paid &&
        !input.voice &&
        // No workspace key fits code, so a workspace that restricts tools at all has none.
        input.workspace.allowedTools === undefined &&
        skillAllows("run_code")
      ) {
        attached.add("run_code");
      }
      if (input.saved && !input.voice && workspacePermits(input.workspace, "memoryRecall") && skillAllows("search_chats")) {
        attached.add("search_chats");
      }
    }

    if (!input.voice) {
      if (skillAllows("current_time")) attached.add("current_time");
      if (skillAllows("calculate")) attached.add("calculate");
    }

    // `taskTool` already carries its own conditions (lockdown, the plan's Work
    // models, the skill); these are the ones the rework adds, and the skill is
    // read again so the plan says the same thing whoever computed `taskTool`.
    if (
      input.taskTool &&
      paid &&
      !input.private &&
      !blocked &&
      !input.voice &&
      !input.regenerate &&
      input.model.agenticTools &&
      skillAllows("start_task")
    ) {
      attached.add("start_task");
    }
  }

  const researchEntitled = input.researchEntitled ?? derivedResearchEntitled(input);
  const suggestResearch =
    functions &&
    web &&
    paid &&
    !input.private &&
    !input.voice &&
    researchEntitled &&
    !input.researchArmed &&
    input.features.has("suggest_research") &&
    workspacePermits(input.workspace, "deepResearch") &&
    skillAllows("suggest_research");
  if (suggestResearch) attached.add("suggest_research");

  const connectors =
    functions && paid && !input.private && !blocked && workspacePermits(input.workspace, "connectors");

  const juno = JUNO_TOOL_IDS.filter((id) => attached.has(id));
  return {
    juno,
    nativeSearch,
    connectors,
    suggestResearch,
    roundBudget,
    notices,
    citationStyle: input.features.has("citations") && attached.has("web_search") ? "numbered" : "links",
  };
}

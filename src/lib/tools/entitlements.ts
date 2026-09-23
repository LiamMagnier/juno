/**
 * Which tools a chat turn carries (SPEC §3.6): one pure function in place of
 * the route's and the skill layer's copies. The composer does not call it —
 * its inputs are server facts — and reads `/api/app` features instead.
 *
 * WS0 lands the signature; WS1 implements the gating matrix.
 */

import type { Plan } from "@prisma/client";

import type { ActionPermissionPolicy } from "@/lib/action-approval";
import type { ClientFeatureSet } from "@/lib/chat/client-features";
import type { ChatSkillApplication } from "@/lib/chat/skills";
import type { ModelInfo } from "@/lib/models";
import type { WorkspaceConfig } from "@/lib/projects/workspace-config";
import type { JunoToolId } from "@/lib/tools/types";
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

export function chatToolEntitlements(_input: EntitlementInput): ChatToolPlan {
  throw new Error("not implemented: WS1");
}

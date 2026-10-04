import "server-only";
import { getActiveConnectors } from "@/lib/mcp";
import { workspacePermits, type WorkspaceConfig } from "@/lib/projects/workspace-config";
import { rangesForStoredText } from "@/lib/chat/context-tokens";
import { TurnContext } from "@/lib/chat/context-resolution";
import { prismaContextPort, regenerateContextTokens } from "@/lib/chat/context-resolve";
import { actionPolicyFromSetting } from "@/lib/chat/app-approval-preview";
import { loadChatSkill } from "@/lib/chat/skill-runtime";
import { CHAT_SKILL_REFUSAL_MESSAGES } from "@/lib/chat/skills";
import type { ChatRequestBody } from "@/lib/chat/request";
import type { ModelInfo } from "@/lib/models";
import type { TurnSettings } from "./account";
import type { TurnUser } from "./types";

/*
 * Pipeline stage 5 — the context a message NAMED (files, apps, skill tokens)
 * and the connectors this turn opens. Phase one of context tokens; phase two
 * runs once the conversation exists (project-context.ts).
 */

/** A skill outcome as the context receipt records it. */
export const skillSettlement = (outcome: Awaited<ReturnType<typeof loadChatSkill>> | null) =>
  outcome === null
    ? null
    : outcome.applied
      ? ({ applied: true } as const)
      : ({ applied: false, message: CHAT_SKILL_REFUSAL_MESSAGES[outcome.reason] } as const);

export async function resolveTurnTokens({
  user,
  input,
  settings,
  workspaceConfig,
  modelInfo,
}: {
  user: TurnUser;
  input: ChatRequestBody;
  settings: TurnSettings;
  workspaceConfig: WorkspaceConfig;
  modelInfo: ModelInfo;
}) {
  // Linked tool connectors (GitHub/Figma…) the user enabled for this message.
  // Never honored in private mode — they'd send the message to a third party.
  const requestedConnectorIDs = workspacePermits(workspaceConfig, "connectors")
    ? (input.connectors ?? []).filter(
        (id) => workspaceConfig.allowedConnectorIds === undefined
          || workspaceConfig.allowedConnectorIds.includes(id)
      )
    : [];
  /*
   * ── Context tokens, phase one (src/lib/chat/context-resolution.ts) ────────
   *
   * The files, apps and skill a message NAMED, resolved before the route
   * opens connectors, writes the user message or loads a skill, because each
   * rides the mechanism that step already is. Every id is checked against
   * this account's rows; one that is not the account's is dropped with a
   * notice, never an error. A request with no tokens resolves nothing and
   * the turn is exactly what it was before tokens existed.
   *
   * A regenerate that sends no `context` re-resolves what the answer it
   * replaces was given (the receipt on that reply), so "try again" does not
   * quietly lose the files and apps the question named.
   */
  const contextTokens =
    input.context !== undefined
      ? input.message !== undefined
        ? rangesForStoredText(input.message, input.context)
        : input.context
      : input.regenerate && input.conversationId && !input.privateMode
        ? await regenerateContextTokens(user.id, input.conversationId).catch(() => [])
        : [];
  const contextPort = prismaContextPort({ userId: user.id, settings, conversationProvider: modelInfo.provider });
  const turnContext = await TurnContext.begin(
    contextTokens,
    {
      privateMode: !!input.privateMode,
      legacyConnectorIds: requestedConnectorIDs,
      workspace: {
        connectorsPermitted: workspacePermits(workspaceConfig, "connectors"),
        allowedConnectorIds: workspaceConfig.allowedConnectorIds,
      },
      attachmentCount: new Set(input.attachmentIds ?? []).size,
      explicitSkillSlug: input.skillSlug ?? null,
      approvals: {
        policy: actionPolicyFromSetting(settings?.actionApprovalPolicy),
        lockdown: !!settings?.lockdownMode,
        blockedConnectors: settings?.blockedConnectors ?? [],
      },
      carriedOver: input.context === undefined && contextTokens.length > 0,
    },
    contextPort
  );
  // This turn's apps: the conversation's (sticky, `connectors`) and the ones
  // this message named (never persisted — see `connectorSelection` below,
  // which still reads only `requestedConnectorIDs`).
  const turnConnectorIDs = [...new Set([...requestedConnectorIDs, ...turnContext.connectorIds])];
  const activeConnectors =
    !input.privateMode && turnConnectorIDs.length
      ? await getActiveConnectors(user.id, turnConnectorIDs, { timeZone: input.timeZone })
      : [];
  turnContext.settleConnectors(activeConnectors);
  /** The skill this message runs under: armed the ordinary way, else named by a token. One per message. */
  const turnSkillSlug = input.skillSlug ?? turnContext.skillSlug ?? undefined;

  return { requestedConnectorIDs, contextPort, turnContext, activeConnectors, turnSkillSlug };
}

export type TurnTokens = Awaited<ReturnType<typeof resolveTurnTokens>>;

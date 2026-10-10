import "server-only";
import { chatConversationEnabled } from "@/lib/cross-conversation/store";
import { CROSS_CONVERSATION_PROMPT_SECTION } from "@/lib/cross-conversation/policy";

/*
 * Pipeline stage: whether this Chat turn carries the cross-conversation tools
 * (src/lib/cross-conversation), and which message from another conversation
 * started it, if one did. The account setting is off for Chat by default; a
 * conversation's own toggle wins. Private turns never get here.
 */
export interface CrossTurn {
  enabled: boolean;
  /** The message this turn answers (a crossReply turn); null for a person's own turn. */
  trigger: { linkId: string; fromRef: string } | null;
  /** Every message this turn handles, marked answered when it ends. */
  linkIds: string[];
}

export async function resolveCrossConversation(input: {
  userId: string;
  conversationId: string;
  crossTrigger: { linkId: string; fromRef: string } | null;
  crossLinkIds: string[];
}): Promise<CrossTurn> {
  const enabled = await chatConversationEnabled(input.userId, input.conversationId);
  return { enabled, trigger: input.crossTrigger, linkIds: input.crossLinkIds };
}

/** The constant section the system prompt gains while the tools are on. */
export function withCrossConversationSection(system: string, cross: CrossTurn | null): string {
  return cross?.enabled ? `${system}\n\n${CROSS_CONVERSATION_PROMPT_SECTION}` : system;
}

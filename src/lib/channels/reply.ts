import "server-only";

/**
 * An agent answering a text, headless, and the two turns mirrored into its
 * thread so the conversation reads the same in the app as on the phone.
 *
 * The answer is a utility walk (`runUtilityPrompt`), the way reflections run:
 * on the account's background provider policy, billed to the account and the
 * agent, refused once the month's budget is spent, and with no tools at all
 * (reply-prompt.ts). It never goes through the chat route, so nothing in it
 * can reach an approval, a connector or a task.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptMessageTextSafe, encryptMessageText } from "@/lib/message-crypto";
import { accountBackgroundProvider, loadBackgroundProviderPolicy, runUtilityPrompt } from "@/lib/memory";
import { ON_ACTIVE_PATH } from "@/lib/chat/branches";
import { agentChatContext, ensureAgentThread, findAgent } from "@/lib/agents/store";
import {
  cleanTextReply,
  TEXT_REPLY_HISTORY,
  TEXT_REPLY_MAX_TOKENS,
  textReplySystem,
  textReplyUserMessage,
} from "@/lib/channels/reply-prompt";

export async function agentTextReply(input: { userId: string; agentId: string; text: string }): Promise<string | null> {
  const context = await agentChatContext({ id: input.userId }, input.agentId, {
    taskHandoff: false,
    handoff: false,
    selfConfig: false,
  });
  if (!context || context.paused) return null;

  const history = context.agent.conversationId
    ? await prisma.message.findMany({
        where: { conversationId: context.agent.conversationId, conversation: { userId: input.userId }, ...ON_ACTIVE_PATH },
        orderBy: { createdAt: "desc" },
        take: TEXT_REPLY_HISTORY,
        select: { role: true, content: true },
      })
    : [];

  const [policy, conversationProvider] = await Promise.all([
    loadBackgroundProviderPolicy(input.userId),
    accountBackgroundProvider(input.userId),
  ]);
  const { result } = await runUtilityPrompt<string>({
    system: textReplySystem(context.block),
    userMsg: textReplyUserMessage(
      history.reverse().map((turn) => ({ role: turn.role, content: decryptMessageTextSafe(turn.content) })),
      input.text
    ),
    maxTokens: TEXT_REPLY_MAX_TOKENS,
    label: "imessage-reply",
    userId: input.userId,
    agentId: input.agentId,
    policy,
    conversationProvider,
    parse: cleanTextReply,
  });
  return result;
}

/**
 * Both turns into the agent's thread, idempotent on the text's handle: a
 * second run for the same text (it cannot happen past the replay ledger, but
 * a retry inside one process could) writes nothing twice.
 */
export async function mirrorTextIntoThread(input: {
  userId: string;
  agentId: string;
  text: string;
  reply: string | null;
  handleHash: string;
}): Promise<void> {
  const agent = await findAgent(input.userId, input.agentId);
  if (!agent) return;
  const conversationId = await ensureAgentThread(input.userId, agent);
  const at = Date.now();
  const key = input.handleHash.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48);
  const turns: { role: "USER" | "ASSISTANT"; content: string; clientId: string; createdAt: Date }[] = [
    { role: "USER", content: input.text, clientId: `imessage_${key}_in`, createdAt: new Date(at - 1) },
  ];
  if (input.reply) turns.push({ role: "ASSISTANT", content: input.reply, clientId: `imessage_${key}_out`, createdAt: new Date(at) });
  for (const turn of turns) {
    try {
      await prisma.message.create({
        data: {
          conversationId,
          role: turn.role,
          content: encryptMessageText(turn.content),
          clientId: turn.clientId,
          createdAt: turn.createdAt,
        },
        select: { id: true },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    }
  }
  await prisma.conversation.updateMany({ where: { id: conversationId, userId: input.userId }, data: { lastMessageAt: new Date(at) } });
}

import "server-only";
import { prisma } from "@/lib/prisma";
import { serializeMessage, serializeArtifact, serializeConversation } from "@/lib/serializers";
import type { ClientArtifact, ClientConversation, ClientMessage } from "@/types/chat";

export async function listConversations(
  userId: string,
  opts: { q?: string; folderId?: string } = {}
): Promise<ClientConversation[]> {
  const q = opts.q?.trim();
  const convos = await prisma.conversation.findMany({
    where: {
      userId,
      ...(opts.folderId ? { folderId: opts.folderId } : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" } },
              { messages: { some: { content: { contains: q, mode: "insensitive" } } } },
            ],
          }
        : {}),
    },
    orderBy: [{ pinned: "desc" }, { lastMessageAt: "desc" }],
    take: 200,
  });
  return convos.map(serializeConversation);
}

export interface ConversationThread {
  conversation: ClientConversation;
  messages: ClientMessage[];
  artifacts: ClientArtifact[];
}

export async function getConversationThread(
  userId: string,
  conversationId: string
): Promise<ConversationThread | null> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
  });
  if (!conversation) return null;

  const [messages, artifacts] = await Promise.all([
    prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
      include: { attachments: true },
    }),
    prisma.artifact.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
      include: { versions: true },
    }),
  ]);

  return {
    conversation: serializeConversation(conversation),
    messages: await Promise.all(messages.map(serializeMessage)),
    artifacts: artifacts.map(serializeArtifact),
  };
}

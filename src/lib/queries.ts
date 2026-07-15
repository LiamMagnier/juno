import "server-only";
import { prisma } from "@/lib/prisma";
import { serializeMessage, serializeArtifact, serializeConversation } from "@/lib/serializers";
import type { ClientArtifact, ClientConversation, ClientMessage } from "@/types/chat";

export interface ListConversationsOptions {
  q?: string;
  folderId?: string;
  /**
   * Archived chats leave the Recent list but stay readable and searchable, so
   * the default hides them while "only" backs an archive view and "include"
   * keeps them reachable from search.
   */
  archived?: "exclude" | "only" | "include";
}

export async function listConversations(
  userId: string,
  opts: ListConversationsOptions = {}
): Promise<ClientConversation[]> {
  const q = opts.q?.trim();
  const archived = opts.archived ?? "exclude";
  const convos = await prisma.conversation.findMany({
    where: {
      userId,
      ...(opts.folderId ? { folderId: opts.folderId } : {}),
      ...(archived === "only" ? { archivedAt: { not: null } } : archived === "exclude" ? { archivedAt: null } : {}),
      // Message bodies are encrypted at rest (see message-crypto.ts), so SQL
      // `contains` can no longer see them — search matches titles only.
      ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
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
      include: {
        attachments: true,
        // Version metadata only (the pager's "‹ 2/3 ›") — contents stay
        // server-side until GET /api/messages/[id]/versions pages them in.
        versions: { select: { id: true, model: true, createdAt: true }, orderBy: { createdAt: "asc" } },
      },
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

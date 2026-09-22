import "server-only";
import { prisma } from "@/lib/prisma";
import type { ConversationAttachment } from "@/lib/agent/attachment-match";

/**
 * Which files a runtime tool is allowed to reach.
 *
 * THE SCOPE IS THE CONVERSATION, AND THAT IS THE SECURITY PROPERTY. A tool
 * that took a bare attachment id and fetched it would let anything that can
 * put text in front of the model — a web page the browser tool read, a
 * connector result, the document itself — name an id and have its contents
 * read out. The model can only ask for files the person has already attached
 * to *this* conversation (or the project it belongs to), so a successful
 * injection asks for something the model was being shown anyway.
 *
 * `userId` is still on every query underneath that: two people's conversation
 * ids are not a namespace anyone should be trusting.
 *
 * Reached through a dynamic import from inside a tool's `execute`, never
 * statically — see the header of `attachment-match.ts` for why the registry
 * must not pull `server-only` into its module graph.
 */

/** Enough for any real conversation; a bound rather than a design limit. */
const MAX_ATTACHMENTS = 60;

export async function conversationAttachments(input: {
  userId: string;
  conversationId?: string | null;
  projectId?: string | null;
  kind?: "IMAGE" | "FILE";
}): Promise<ConversationAttachment[]> {
  const scopes: Record<string, unknown>[] = [];
  // Both links, because they are set at different moments: `conversationId` at
  // upload time for a file dropped into an open chat, `messageId` when the
  // turn commits and claims it. A library file picked into a message only ever
  // gets the second.
  if (input.conversationId && input.conversationId !== "private") {
    scopes.push({ conversationId: input.conversationId });
    scopes.push({ message: { conversationId: input.conversationId } });
  }
  if (input.projectId) scopes.push({ projectId: input.projectId });
  if (scopes.length === 0) return [];

  const rows = await prisma.attachment.findMany({
    where: {
      userId: input.userId,
      deletedAt: null,
      ...(input.kind ? { kind: input.kind } : {}),
      OR: scopes,
    },
    orderBy: { createdAt: "asc" },
    take: MAX_ATTACHMENTS,
    select: {
      id: true,
      fileName: true,
      mimeType: true,
      kind: true,
      storageKey: true,
      size: true,
      parserState: true,
      createdAt: true,
    },
  });
  return rows as ConversationAttachment[];
}

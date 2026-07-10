import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { serializeConversation } from "@/lib/serializers";
import { truncate } from "@/lib/utils";

const schema = z.object({ atMessageId: z.string().cuid() });

/**
 * Branch-from-here: copy a conversation up to (and including) one message into
 * a brand-new conversation the client then navigates to. The branch keeps the
 * original's model/project/folder/connectors and records its origin in
 * forkedFromId (a plain pointer — the source may be deleted independently).
 *
 * Copy semantics, deliberately narrow:
 * - Message ciphertext is copied VERBATIM: message-crypto is row-independent
 *   (AES-GCM, random IV per row, no id/conversation binding), so re-encryption
 *   is unnecessary. Verified against src/lib/message-crypto.ts.
 * - MessageVersion history is NOT copied — a branch snapshots the current
 *   state of the thread, not its edit/regenerate history.
 * - Attachments and artifacts are NOT copied: attachment rows own storage-
 *   object lifecycles scoped to their conversation, so duplicating them would
 *   let deleting one thread break the other; artifacts stay with the canvas
 *   they were created in.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const conversation = await prisma.conversation.findFirst({ where: { id, userId: user.id } });
  if (!conversation) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const anchor = await prisma.message.findFirst({
    where: { id: parsed.data.atMessageId, conversationId: conversation.id },
    select: { id: true, createdAt: true },
  });
  if (!anchor) return NextResponse.json({ error: "Message not found in this conversation." }, { status: 404 });

  const source = await prisma.message.findMany({
    where: { conversationId: conversation.id, createdAt: { lte: anchor.createdAt } },
    orderBy: { createdAt: "asc" },
  });

  // Conversation + copied messages land atomically — never a half-built branch.
  const fork = await prisma.$transaction(async (tx) => {
    const created = await tx.conversation.create({
      data: {
        userId: user.id,
        title: `${truncate(conversation.title, 110)} (branch)`,
        // "manual" so auto-titling never renames the branch away from its origin.
        titleSource: "manual",
        model: conversation.model,
        folderId: conversation.folderId,
        projectId: conversation.projectId,
        forkedFromId: conversation.id,
        activeConnectors: conversation.activeConnectors,
      },
    });
    if (source.length) {
      await tx.message.createMany({
        data: source.map((m) => ({
          conversationId: created.id,
          role: m.role,
          content: m.content, // ciphertext copied verbatim (row-independent crypto)
          reasoning: m.reasoning,
          model: m.model,
          feedback: m.feedback,
          promptTokens: m.promptTokens,
          completionTokens: m.completionTokens,
          sources: m.sources === null ? Prisma.DbNull : (m.sources as unknown as Prisma.InputJsonValue),
          activity: m.activity === null ? Prisma.DbNull : (m.activity as unknown as Prisma.InputJsonValue),
          // Preserve original timestamps so ordering and history windows match.
          createdAt: m.createdAt,
        })),
      });
    }
    return created;
  });

  return NextResponse.json({ conversation: serializeConversation(fork) });
}

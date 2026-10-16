import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { serializeConversation } from "@/lib/serializers";
import { truncate } from "@/lib/utils";
import { pathIdsTo } from "@/lib/chat/branches";
import { OLDEST_FIRST } from "@/lib/chat/history-page";

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
 * - Only the path that leads to the message is copied: its ancestors, by the
 *   branch tree (src/lib/chat/branches.ts). Hidden branches — earlier
 *   wordings and answers an edit or regenerate kept — and MessageVersion
 *   history are NOT copied: a new chat snapshots one line of the thread, not
 *   its alternatives, and starts with no pager to step through.
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

  const path = await pathIdsTo(prisma, conversation.id, parsed.data.atMessageId);
  if (!path) return NextResponse.json({ error: "Message not found in this conversation." }, { status: 404 });

  const source = await prisma.message.findMany({
    where: { conversationId: conversation.id, id: { in: path } },
    orderBy: OLDEST_FIRST,
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
          // Carried with the token counts, not dropped. A fork is a copy of
          // generations that already happened, so their measurements still
          // apply — and copying the totals while losing the split would make
          // the fork claim it knows the input size but not how much of it was
          // cached, which is a fact the original row does hold. NULL copies as
          // NULL: unknown stays unknown rather than becoming a zero.
          cacheReadTokens: m.cacheReadTokens,
          cacheWriteTokens: m.cacheWriteTokens,
          // The exact price of the same generation, so the branch does not
          // quote a different one. serializeMessage prefers this over
          // recomputing from promptTokens/completionTokens, and that recompute
          // drops cache writes and web-search fees — so dropping the column
          // here does not make the cost unknown, it makes it silently WRONG:
          // the branch renders a cheaper number than the thread it was copied
          // from, for identical rows. NULL copies as NULL, which lands on the
          // same estimate the original already falls back to.
          costMicroUsd: m.costMicroUsd,
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

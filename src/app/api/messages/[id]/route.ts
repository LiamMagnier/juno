import { NextResponse } from "next/server";
import { markRoutingSignal } from "@/lib/router/telemetry-store";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { encryptMessageText } from "@/lib/message-crypto";
import { getCurrentUser } from "@/lib/session";
import { branchRefusalResponse, copyMessageAttachments, forkMessage } from "@/lib/chat/branches";
import { isRefusal } from "@/lib/chat/branch-model";
import { getClientMessage } from "@/lib/queries";

const schema = z.object({ content: z.string().trim().min(1) });

/**
 * Edit a question: a NEW BRANCH, never a truncation (src/lib/chat/branches.ts).
 *
 * The edited wording is written as a sibling of the original message, with the
 * same parent and a copy of its attachments, and becomes the shown branch. The
 * original and every message that followed it stay exactly as they were, off
 * the shown path, and the "‹ 1/2 ›" pager under the question switches back to
 * them. Nothing is deleted, so nothing has to be detached, settled or
 * re-indexed: artifacts keep their message, files keep theirs.
 *
 * The client asks for the new answer next (POST /api/chat with `regenerate`),
 * which answers the shown leaf — the new wording.
 *
 * Response: the new message as the transcript renders it, and `replacedId`,
 * the row the client replaces it from.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const message = await prisma.message.findFirst({
    where: { id, conversation: { userId: user.id } },
    select: { id: true, role: true, conversationId: true },
  });
  if (!message) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (message.role !== "USER") return NextResponse.json({ error: "Only your messages can be edited." }, { status: 400 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const result = await prisma.$transaction(async (tx) => {
    const forked = await forkMessage(tx, { userId: user.id, conversationId: message.conversationId, targetId: id }, async (fields) => {
      const created = await tx.message.create({
        data: {
          conversationId: message.conversationId,
          role: "USER",
          content: encryptMessageText(parsed.data.content),
          ...fields,
        },
        select: { id: true },
      });
      // The question keeps its files: the new wording is asked about the same
      // attachments, and the old branch keeps its own rows.
      await copyMessageAttachments(tx, user.id, { fromMessageId: id, toMessageId: created.id, conversationId: message.conversationId });
      return created;
    });
    if (isRefusal(forked)) return forked;
    // The answers this edit moved off the path were not what the reader wanted.
    const discarded = await tx.message.findMany({
      where: { conversationId: message.conversationId, id: { in: forked.plan.hidden }, role: "ASSISTANT" },
      select: { id: true },
    });
    return { created: forked.created, discarded: discarded.map((row) => row.id) };
  });
  if (isRefusal(result)) {
    const refusal = branchRefusalResponse(result);
    return NextResponse.json({ error: refusal.error }, { status: refusal.status });
  }
  // A signal for Auto's feedback loop, on content-free rows (src/lib/router/telemetry-store.ts).
  await markRoutingSignal(result.discarded, { edited: true });

  const created = await getClientMessage(message.conversationId, result.created.id);
  return NextResponse.json({ ok: true, message: created, replacedId: id });
}

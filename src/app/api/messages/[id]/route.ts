import { NextResponse } from "next/server";
import { markRoutingSignal } from "@/lib/router/telemetry-store";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { encryptMessageText } from "@/lib/message-crypto";
import { getCurrentUser } from "@/lib/session";
import { settleLibraryRemovalsBeforeTruncation } from "@/lib/library-removal";

const schema = z.object({ content: z.string().trim().min(1) });

/**
 * Edit a user message: update its content and truncate everything after it.
 * The ORIGINAL content is snapshotted into a MessageVersion first (ciphertext
 * copied verbatim — the crypto is row-independent, see message-crypto.ts), so
 * an edit never destroys history: the pager on the message shows every prior
 * wording, oldest first, with the Message row always holding the newest.
 *
 * Artifacts made by the truncated answers are NOT deleted. They can carry
 * hand edits, design checkpoints and public share links; they stay, detached,
 * and the next answer that emits the same identifier appends a version to
 * the same row (see detachArtifactsFromMessage in artifacts-store.ts).
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const message = await prisma.message.findFirst({
    where: { id, conversation: { userId: user.id } },
  });
  if (!message) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (message.role !== "USER") return NextResponse.json({ error: "Only your messages can be edited." }, { status: 400 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const result = await prisma.$transaction(async (tx) => {
    // Preserve the pre-edit wording as read-only history.
    const version = await tx.messageVersion.create({
      data: { messageId: message.id, content: message.content },
    });
    await tx.message.update({ where: { id }, data: { content: encryptMessageText(parsed.data.content) } });
    // Its session-recall tokens describe the old wording: drop them, and the
    // next index pass re-reads the new one (src/lib/recall).
    await tx.messageRecallIndex.deleteMany({ where: { messageId: id, userId: user.id } });
    // The later messages' attachments survive their delete (messageId is
    // SetNull). A file the reader had taken out of the Library stayed only
    // because one of these messages used it; with the message gone it is
    // deleted as they asked, rather than left in Recently deleted with
    // nothing using it.
    await settleLibraryRemovalsBeforeTruncation(tx, user.id, message.id);
    // Later messages' own MessageVersion rows cascade with them. Their
    // artifacts do not: Artifact.messageId is SetNull too, so each one is
    // detached here with its versions and share links intact.
    const discarded = await tx.message.findMany({
      where: { conversationId: message.conversationId, createdAt: { gt: message.createdAt }, role: "ASSISTANT" },
      select: { id: true },
    });
    await tx.message.deleteMany({
      where: { conversationId: message.conversationId, createdAt: { gt: message.createdAt } },
    });
    return { version, discarded: discarded.map((m) => m.id) };
  });
  // The answers this edit discarded were not what the reader wanted: a signal
  // for Auto's feedback loop, on content-free rows (src/lib/router/telemetry-store.ts).
  await markRoutingSignal(result.discarded, { edited: true });
  const version = result.version;

  // Version metadata so the client can grow the pager without a refetch.
  return NextResponse.json({
    ok: true,
    version: { id: version.id, model: version.model, createdAt: version.createdAt.toISOString() },
  });
}

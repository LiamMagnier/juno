import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { encryptMessageText } from "@/lib/message-crypto";
import { getCurrentUser } from "@/lib/session";

const schema = z.object({ content: z.string().trim().min(1).max(50_000) });

/**
 * Edit a user message: update its content and truncate everything after it.
 * The ORIGINAL content is snapshotted into a MessageVersion first (ciphertext
 * copied verbatim — the crypto is row-independent, see message-crypto.ts), so
 * an edit never destroys history: the pager on the message shows every prior
 * wording, oldest first, with the Message row always holding the newest.
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

  const [version] = await prisma.$transaction([
    // Preserve the pre-edit wording as read-only history.
    prisma.messageVersion.create({
      data: { messageId: message.id, content: message.content },
    }),
    prisma.message.update({ where: { id }, data: { content: encryptMessageText(parsed.data.content) } }),
    // Drop later messages (their artifacts cascade via the later messages' deletion is not automatic
    // for messageId=SetNull, so delete artifacts explicitly below).
    prisma.artifact.deleteMany({
      where: { conversationId: message.conversationId, message: { createdAt: { gt: message.createdAt } } },
    }),
    // Later messages' own MessageVersion rows cascade with them.
    prisma.message.deleteMany({
      where: { conversationId: message.conversationId, createdAt: { gt: message.createdAt } },
    }),
  ]);

  // Version metadata so the client can grow the pager without a refetch.
  return NextResponse.json({
    ok: true,
    version: { id: version.id, model: version.model, createdAt: version.createdAt.toISOString() },
  });
}

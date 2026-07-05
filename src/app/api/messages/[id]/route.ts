import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { encryptMessageText } from "@/lib/message-crypto";
import { getCurrentUser } from "@/lib/session";

const schema = z.object({ content: z.string().trim().min(1).max(50_000) });

/** Edit a user message: update its content and truncate everything after it. */
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

  await prisma.$transaction([
    prisma.message.update({ where: { id }, data: { content: encryptMessageText(parsed.data.content) } }),
    // Drop later messages (their artifacts cascade via the later messages' deletion is not automatic
    // for messageId=SetNull, so delete artifacts explicitly below).
    prisma.artifact.deleteMany({
      where: { conversationId: message.conversationId, message: { createdAt: { gt: message.createdAt } } },
    }),
    prisma.message.deleteMany({
      where: { conversationId: message.conversationId, createdAt: { gt: message.createdAt } },
    }),
  ]);

  return NextResponse.json({ ok: true });
}

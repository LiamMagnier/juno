import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { decryptMessageTextSafe } from "@/lib/message-crypto";
import { getCurrentUser } from "@/lib/session";
import type { ClientMessageVersionDetail, ClientSource } from "@/types/chat";

/**
 * List the preserved prior versions of a message (regenerate / edit-and-resend
 * history), oldest first, decrypted server-side like every other message read.
 * The live Message row is NOT included — it is always the newest version and
 * the client already holds it; this endpoint only pages in the older contents
 * when the user steps back through the "‹ 2/3 ›" pager.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const message = await prisma.message.findFirst({
    where: { id, conversation: { userId: user.id } },
    select: { id: true },
  });
  if (!message) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const versions = await prisma.messageVersion.findMany({
    where: { messageId: message.id },
    orderBy: { createdAt: "asc" },
  });

  const payload: ClientMessageVersionDetail[] = versions.map((v) => ({
    id: v.id,
    content: decryptMessageTextSafe(v.content),
    reasoning: v.reasoning != null ? decryptMessageTextSafe(v.reasoning) : undefined,
    model: v.model,
    promptTokens: v.promptTokens,
    completionTokens: v.completionTokens,
    sources: (v.sources as ClientSource[] | null) ?? undefined,
    createdAt: v.createdAt.toISOString(),
  }));

  return NextResponse.json({ versions: payload });
}

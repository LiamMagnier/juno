import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { activeGenerationForConversation } from "@/lib/generation-cancel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Which generation, if any, is still running for a conversation — so a tab
 * that reopens a chat without its sessionStorage ledger (a closed tab, a new
 * window) can still find the stream to resume.
 *
 * Two sources, both ownership-checked: this process's registry (every live
 * web turn) and a `running` durable receipt (native first submissions). A
 * generation whose process died is in neither and answers 404; the client
 * then falls back to loading the conversation, which is where that answer
 * ended up — or did not.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const conversationId = new URL(req.url).searchParams.get("conversationId")?.trim() ?? "";
  if (!conversationId) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId: user.id },
    select: { id: true },
  });
  if (!conversation) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const live = activeGenerationForConversation(conversationId, user.id);
  if (live) return NextResponse.json({ generationId: live });

  const receipt = await prisma.chatFirstSubmissionReceipt.findFirst({
    where: { userId: user.id, conversationId, state: "running", leaseExpiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    select: { generationId: true },
  });
  if (receipt) return NextResponse.json({ generationId: receipt.generationId });
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

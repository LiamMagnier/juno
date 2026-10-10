import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { pendingChatReplies, unreadCrossConversationIds } from "@/lib/cross-conversation/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/cross-messages/pending — what an open client of the account acts
 * on: Chat conversations owing a reply to another conversation's message (the
 * client runs it with POST /api/chat { crossReply }), and Chat conversations
 * with a message the reader has not opened (the sidebar's unread title).
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const [replies, unread] = await Promise.all([pendingChatReplies(user.id), unreadCrossConversationIds(user.id)]);
  return NextResponse.json({ replies, unread }, { headers: { "Cache-Control": "no-store" } });
}

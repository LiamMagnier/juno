import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { RECAP_PERIODS, recapThemes } from "@/lib/memory-recap";

/*
 * The part of the recap the memory page does not already have loaded: what the
 * period's conversations were about.
 *
 * Everything else a recap shows — learned, replaced, forgotten, leaned on — is
 * derived in the browser from the rows the page already fetched (see
 * src/lib/memory-recap.ts), so this route answers one question and reads two
 * small things: the extractor's one-line digests of the chats active in the
 * window, and how many there were.
 *
 * `ConversationMemory.updatedAt` moves whenever extraction advances a chat's
 * high-water mark, which happens after the turns that chat receives — so it is
 * a fair stand-in for "this chat was active". Incognito chats are never stored,
 * so they are never here.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const requested = Number(new URL(req.url).searchParams.get("days"));
  const days = (RECAP_PERIODS as readonly number[]).includes(requested) ? requested : 30;
  const since = new Date(Date.now() - days * 86_400_000);

  const [digests, conversations] = await Promise.all([
    prisma.conversationMemory.findMany({
      where: { userId: user.id, updatedAt: { gte: since }, digest: { not: null } },
      orderBy: { updatedAt: "desc" },
      take: 40,
      select: { digest: true },
    }),
    prisma.conversation.count({
      where: { userId: user.id, kind: "chat", lastMessageAt: { gte: since } },
    }),
  ]);

  return NextResponse.json({
    days,
    themes: recapThemes(digests.map((row) => row.digest)),
    conversations,
  });
}

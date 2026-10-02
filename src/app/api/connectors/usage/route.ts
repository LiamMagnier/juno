import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import type { ConnectorUsage } from "@/components/connections/types";

export const runtime = "nodejs";

/** At most this many apps are reported; an account links far fewer. */
const MAX_APPS = 200;


/**
 * GET /api/connectors/usage: when each app was last used, for the app's
 * details in Customize ("Last used"). Read from the tool-call audit log
 * (`ToolInvocation`, written before every dispatched connector call), newest
 * executed call per connector, owner-scoped. Arguments are never returned:
 * they are user content, and the line needs only the tool and the chat.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const latest = await prisma.toolInvocation.findMany({
    where: { userId: user.id, status: "executed" },
    orderBy: [{ connectorId: "asc" }, { createdAt: "desc" }],
    distinct: ["connectorId"],
    take: MAX_APPS,
    select: { connectorId: true, toolName: true, access: true, conversationId: true, createdAt: true },
  });

  const chatIds = [...new Set(latest.map((row) => row.conversationId).filter((id): id is string => Boolean(id)))];
  const chats =
    chatIds.length > 0
      ? await prisma.conversation.findMany({
          where: { userId: user.id, id: { in: chatIds } },
          select: { id: true, title: true },
        })
      : [];
  const titles = new Map(chats.map((chat) => [chat.id, chat.title]));

  const usage: Record<string, ConnectorUsage> = {};
  for (const row of latest) {
    const owned = row.conversationId && titles.has(row.conversationId) ? row.conversationId : null;
    usage[row.connectorId] = {
      at: row.createdAt.toISOString(),
      toolName: row.toolName,
      access: row.access,
      conversationId: owned,
      conversationTitle: owned ? (titles.get(owned) ?? null) : null,
    };
  }
  return NextResponse.json({ usage }, { headers: { "Cache-Control": "private, no-store" } });
}

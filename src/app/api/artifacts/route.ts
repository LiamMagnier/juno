import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";

// All artifacts the user has created across conversations — the Canvas library.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const artifacts = await prisma.artifact.findMany({
    where: { conversation: { userId: user.id } },
    orderBy: { updatedAt: "desc" },
    take: 200,
    select: {
      id: true,
      identifier: true,
      title: true,
      type: true,
      language: true,
      currentVersion: true,
      conversationId: true,
      createdAt: true,
      updatedAt: true,
      conversation: { select: { title: true } },
    },
  });

  return NextResponse.json({
    items: artifacts.map((a) => ({
      id: a.id,
      identifier: a.identifier,
      title: a.title,
      type: a.type,
      language: a.language,
      version: a.currentVersion,
      conversationId: a.conversationId,
      conversationTitle: a.conversation.title,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    })),
  });
}

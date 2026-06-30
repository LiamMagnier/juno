import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";

/** Export the user's data as a downloadable JSON file (GDPR-style data export). */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [account, settings, conversations, memories] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.id }, select: { name: true, email: true, createdAt: true } }),
    prisma.settings.findUnique({ where: { userId: user.id } }),
    prisma.conversation.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
          select: { role: true, content: true, model: true, createdAt: true },
        },
      },
    }),
    prisma.memoryEntry.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" }, select: { content: true, source: true, createdAt: true } }),
  ]);

  const payload = {
    exportedAt: new Date().toISOString(),
    account,
    settings,
    memories,
    conversations: conversations.map((c) => ({ title: c.title, createdAt: c.createdAt, messages: c.messages })),
  };

  return new NextResponse(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="juno-export-${Date.now()}.json"`,
    },
  });
}

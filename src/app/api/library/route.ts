import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { serializeAttachment } from "@/lib/serializers";

export const runtime = "nodejs";

// Every file/image the user has sent in chat — the Library.
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const kind = new URL(req.url).searchParams.get("kind");
  const atts = await prisma.attachment.findMany({
    where: { userId: user.id, ...(kind === "IMAGE" || kind === "FILE" ? { kind } : {}) },
    orderBy: { createdAt: "desc" },
    take: 300,
  });

  const items = await Promise.all(
    atts.map(async (a) => ({
      ...(await serializeAttachment(a)),
      createdAt: a.createdAt.toISOString(),
      conversationId: a.conversationId,
    }))
  );

  return NextResponse.json({ items });
}

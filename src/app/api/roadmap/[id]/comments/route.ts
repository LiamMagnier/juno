import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { isOwnerEmail } from "@/lib/owner";

const schema = z.object({
  body: z.string().trim().min(1).max(2000),
  official: z.boolean().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = await rateLimit({ key: `roadmap:comment:${user.id}`, limit: 20, windowSec: 3600 });
  if (!limit.success) {
    return NextResponse.json({ error: "Slow down a moment, then try again." }, { status: 429 });
  }

  const { id } = await params;
  const request = await prisma.featureRequest.findUnique({ where: { id }, select: { id: true } });
  if (!request) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  // Only the owner can post an "official" reply.
  const official = !!parsed.data.official && isOwnerEmail(user.email);

  const comment = await prisma.featureComment.create({
    data: { requestId: id, authorId: user.id, body: parsed.data.body, official },
    include: { author: { select: { id: true, name: true } } },
  });

  return NextResponse.json(
    {
      comment: {
        id: comment.id,
        body: comment.body,
        official: comment.official,
        createdAt: comment.createdAt.toISOString(),
        author: comment.author,
      },
    },
    { status: 201 }
  );
}

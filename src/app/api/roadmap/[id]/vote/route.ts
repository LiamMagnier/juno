import { NextResponse } from "next/server";
import { prisma, prismaUnguarded } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";

// Toggle the current user's vote on a request (one vote per user).
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const request = await prisma.featureRequest.findUnique({ where: { id }, select: { id: true } });
  if (!request) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const existing = await prisma.featureVote.findUnique({
    where: { requestId_userId: { requestId: id, userId: user.id } },
  });

  if (existing) {
    await prisma.featureVote.delete({ where: { id: existing.id, userId: user.id } });
  } else {
    await prisma.featureVote.create({ data: { requestId: id, userId: user.id } });
  }

  // The public tally across everyone's votes, so deliberately unscoped: it
  // reads a number, not anyone's rows. Guarded, it threw after the toggle above
  // had already been written.
  const voteCount = await prismaUnguarded.featureVote.count({ where: { requestId: id } });
  return NextResponse.json({ voted: !existing, voteCount });
}

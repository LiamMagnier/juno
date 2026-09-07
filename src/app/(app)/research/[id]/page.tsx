import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/db";
export default async function ResearchRunPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const run = await prisma.researchRun.findFirst({ where: { id, userId: user.id }, select: { conversationId: true } });
  if (!run) notFound();
  redirect(run.conversationId ? `/chat/${run.conversationId}?researchRun=${encodeURIComponent(id)}` : `/chat?researchRun=${encodeURIComponent(id)}`);
}

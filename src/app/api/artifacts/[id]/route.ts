import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { serializeArtifact } from "@/lib/serializers";

const schema = z.object({ content: z.string().max(200_000) });

/** Save a manual edit as a new artifact version. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const artifact = await prisma.artifact.findFirst({
    where: { id, conversation: { userId: user.id } },
    include: { versions: true },
  });
  if (!artifact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const nextVersion = artifact.currentVersion + 1;
  await prisma.artifactVersion.create({
    data: { artifactId: artifact.id, version: nextVersion, content: parsed.data.content },
  });
  const updated = await prisma.artifact.update({
    where: { id: artifact.id },
    data: { currentVersion: nextVersion },
    include: { versions: true },
  });

  return NextResponse.json({ artifact: serializeArtifact(updated) });
}

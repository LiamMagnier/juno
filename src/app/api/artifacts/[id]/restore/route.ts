import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { restoreArtifact } from "@/lib/artifact-trash";
import { artifactWriteLimited } from "@/lib/artifact-rate-limit";
import { ARTIFACT_SEALED_INCLUDE, serializeArtifact } from "@/lib/serializers";
import { ownedArtifactWhere } from "@/lib/artifact-access";

export const runtime = "nodejs";

/**
 * Bring an artifact back from Recently deleted. Idempotent: restoring a live
 * artifact answers it unchanged. Its links (share and publication) serve
 * again under the same tokens.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await artifactWriteLimited(user, "delete");
  if (limited) return limited;

  const { id } = await params;
  if (!(await restoreArtifact(user.id, id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const artifact = await prisma.artifact.findFirst({
    where: ownedArtifactWhere(user.id, { id }),
    include: ARTIFACT_SEALED_INCLUDE,
  });
  if (!artifact) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ artifact: serializeArtifact(artifact) });
}

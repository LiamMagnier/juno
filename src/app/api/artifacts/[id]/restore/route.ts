import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { ARTIFACT_CLIENT_INCLUDE, serializeArtifact } from "@/lib/serializers";
import { restoreArtifact } from "@/lib/artifact-trash";

/**
 * POST /api/artifacts/{id}/restore — bring an artifact back from Recently
 * deleted. Answers `{ artifact }`, the same shape every other artifact route
 * returns, so the Undo toast and the trash list can drop it straight back into
 * a live list.
 *
 * Idempotent: restoring a live artifact answers it as it is. That is what
 * makes Undo safe to double-click and a retried request harmless.
 *
 * Its public link needs nothing: the Share row was never touched, so the same
 * token serves again from the next request.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!(await restoreArtifact(user.id, id))) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Read back as live. Null only if it was trashed again or purged in the
  // moment since, and then it is, truthfully, not there to show.
  const artifact = await prisma.artifact.findFirst({
    where: { id, conversation: { userId: user.id }, deletedAt: null },
    include: ARTIFACT_CLIENT_INCLUDE,
  });
  if (!artifact) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ artifact: serializeArtifact(artifact) });
}

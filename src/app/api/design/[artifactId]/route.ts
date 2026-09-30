import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { documentAtVersion, documentFromArtifact, loadOwnedDesignArtifact, serializeDesignArtifact } from "@/lib/design/store";
import { DesignValidationError } from "@/lib/design/schema";

export const runtime = "nodejs";

/**
 * Read one design document.
 *
 * Ownership is the artifact's own (`Artifact.userId`), so a design is its
 * owner's whether or not it still has a chat. Without `?version=` this is the
 * working copy — the unsealed draft when there is one — which is what the
 * editor opens. `?version=` reads one earlier version without restoring it,
 * which is what the history panel needs to show an older state
 * non-destructively; only that one body is read.
 */
export async function GET(req: Request, { params }: { params: Promise<{ artifactId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { artifactId } = await params;
  const artifact = await loadOwnedDesignArtifact(artifactId, user.id);
  if (!artifact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const requested = new URL(req.url).searchParams.get("version");
  const version = requested ? Number.parseInt(requested, 10) : undefined;
  if (requested && (!Number.isInteger(version) || version! < 1)) {
    return NextResponse.json({ error: "Invalid version" }, { status: 400 });
  }

  try {
    const document = version === undefined ? documentFromArtifact(artifact) : await documentAtVersion(artifact, version);
    return NextResponse.json({ artifact: serializeDesignArtifact(artifact), document });
  } catch (error) {
    if (error instanceof DesignValidationError) {
      // A document this build cannot read is a real state, and saying so beats
      // returning an empty canvas that looks like data loss.
      return NextResponse.json({ error: error.message, issues: error.issues }, { status: 422 });
    }
    throw error;
  }
}

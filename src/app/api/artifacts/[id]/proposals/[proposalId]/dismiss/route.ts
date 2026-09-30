import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { artifactWriteLimited } from "@/lib/artifact-rate-limit";
import { dismissArtifactProposal } from "@/lib/artifacts-store";

export const runtime = "nodejs";

/**
 * POST /api/artifacts/{id}/proposals/{proposalId}/dismiss — let a suggestion
 * go. It is stored as DISCARDED (the status M4 keeps, so nothing is renamed
 * later); the people using it see "Dismiss". The artifact does not change.
 *
 * `{ artifact }` on success and on a repeated dismiss. 409 `{ error:
 * "resolved", artifact }` when it was applied or superseded meanwhile; the
 * artifact then carries whatever is waiting now.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string; proposalId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await artifactWriteLimited(user, "save");
  if (limited) return limited;

  const { id, proposalId } = await params;
  const result = await dismissArtifactProposal(user.id, id, proposalId);
  if (result.ok) return NextResponse.json({ artifact: result.artifact });
  if (result.error === "not_found") return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ error: result.error, artifact: result.artifact }, { status: 409 });
}

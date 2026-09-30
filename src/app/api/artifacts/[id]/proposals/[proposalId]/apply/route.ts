import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { artifactWriteLimited } from "@/lib/artifact-rate-limit";
import { applyArtifactProposal } from "@/lib/artifacts-store";

const bodySchema = z.object({
  /** The version the person compared the suggestion against: Apply's stale check. */
  baseVersion: z.number().int().positive(),
});

export const runtime = "nodejs";

/**
 * POST /api/artifacts/{id}/proposals/{proposalId}/apply — make a suggestion
 * the next version (see `applyArtifactProposal`).
 *
 * 409 `{ error: "stale", artifact }` when the artifact moved since the person
 * compared it (a save, another Apply), so the UI can say "This changed since
 * the suggestion was made. Compare again before applying." instead of writing
 * over work nobody reviewed. 409 `{ error: "resolved", artifact }` when the
 * suggestion was already applied, dismissed or superseded. Either carries the
 * artifact as it now is. 404 for a trashed artifact, as every artifact route.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; proposalId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await artifactWriteLimited(user, "save");
  if (limited) return limited;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const { id, proposalId } = await params;
  const result = await applyArtifactProposal(user.id, id, proposalId, parsed.data.baseVersion);
  if (result.ok) return NextResponse.json({ artifact: result.artifact });
  if (result.error === "not_found") return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ error: result.error, artifact: result.artifact }, { status: 409 });
}

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { loadOwnedProposal } from "@/lib/artifacts-store";
import { readProposalPayload } from "@/lib/artifact-proposals";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; proposalId: string }> };

/**
 * GET /api/artifacts/{id}/proposals/{proposalId} — one of Juno's suggestions
 * beside the version it would replace, for Compare.
 *
 * (Taken from artifacts/r1-lifecycle.) The suggestion's content is never in a
 * chat load or an artifact payload (`ARTIFACT_CLIENT_INCLUDE` carries only its
 * label), so it is fetched here,
 * when someone asks to compare. For a DESIGN both bodies are null: a design is
 * compared as two pictures, `…/poster` for the suggestion and the artifact's
 * own poster for the current version, never as a diff of document JSON.
 *
 * 404 for anything that is not this user's, for a trashed artifact and for a
 * suggestion that belongs to another artifact, all alike.
 */
export async function GET(_req: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, proposalId } = await params;
  const owned = await loadOwnedProposal(user.id, id, proposalId);
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { artifact, proposal } = owned;
  const design = artifact.type === "DESIGN";
  const payload = readProposalPayload(proposal.payload);

  const current = design
    ? null
    : ((await prisma.artifactVersion.findUnique({
        where: { artifactId_version: { artifactId: artifact.id, version: artifact.currentVersion } },
        select: { content: true },
      })) ??
      // `currentVersion` should always name a row; if a legacy one does not,
      // the newest row is what every reader shows as current.
      (await prisma.artifactVersion.findFirst({
        where: { artifactId: artifact.id },
        orderBy: { version: "desc" },
        select: { content: true },
      })));

  return NextResponse.json({
    proposal: {
      id: proposal.id,
      baseVersion: proposal.baseVersion,
      summary: proposal.summary,
      status: proposal.status,
      createdAt: proposal.createdAt.toISOString(),
      type: artifact.type,
      title: payload?.title || artifact.title,
      content: design ? null : (payload?.content ?? null),
    },
    current: { version: artifact.currentVersion, content: current?.content ?? null },
  });
}

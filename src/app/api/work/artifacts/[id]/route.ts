import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { serializeArtifact } from "@/lib/work/serializers";
import { provenanceFromStorage } from "@/lib/work/deliverables";

export const runtime = "nodejs";

/**
 * How much history one response carries.
 *
 * A deliverable regenerated on every run of a daily schedule accumulates
 * versions indefinitely, and the surface that shows this is a list of a handful
 * of entries with a download beside each. Capping at the newest hundred keeps a
 * two-year-old artifact from answering with a megabyte of provenance nobody
 * scrolls to.
 */
const VERSION_HISTORY_LIMIT = 100;

const UNVALIDATED_WARNING =
  "The current version of this deliverable has not been re-opened successfully by the " +
  "validator, so nothing has confirmed that it opens. Check it before sending it to anyone.";

/**
 * One artifact, its version history and where each version's content came from.
 *
 * `storageKey` is deliberately absent from every version in the response. It is
 * the object's address, it is the same string in every environment, and in a
 * deployment with a public bucket URL it is most of a download link that needs
 * no session at all. Clients ask for bytes through the download route, which
 * checks ownership and verifies the hash; there is nothing a client could do
 * with the key that the download route does not already do better.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const artifact = await prisma.workArtifact.findFirst({
    where: { id, userId: user.id, deletedAt: null },
  });
  if (!artifact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Version rows carry no owner column; ownership is the head row's, which is
  // why the head is loaded with `userId` in the WHERE before this runs at all.
  const versions = await prisma.workArtifactVersion.findMany({
    where: { artifactId: artifact.id },
    orderBy: { version: "desc" },
    take: VERSION_HISTORY_LIMIT,
  });

  return NextResponse.json({
    artifact: serializeArtifact(artifact),
    versions: versions.map((version) => ({
      version: version.version,
      byteSize: version.byteSize,
      /** SHA-256 of the stored bytes. The download route re-checks it. */
      contentHash: version.contentHash,
      origin: version.origin,
      runId: version.runId,
      // Read through the deliverables module's own reader, which drops entries
      // this build cannot interpret. A citation rendered from a half-understood
      // entry is worse than an absent one, because a reviewer would check it.
      provenance: provenanceFromStorage(version.provenance),
      provenanceVersion: version.provenanceVersion,
      // Passed through as stored, the way `serializeEvent` passes a payload.
      // The verdict carries the validator name it was produced by, so a client
      // reading a row written by an older build can tell which rules it passed
      // rather than assuming today's.
      validation: version.validation,
      createdAt: version.createdAt.toISOString(),
    })),
    // Stated as a sentence rather than left to be inferred from
    // `validatedAt: null`, so a surface that renders this artifact has to make a
    // decision about it instead of quietly showing a download button.
    ...(artifact.validatedAt === null ? { warning: UNVALIDATED_WARNING } : {}),
    truncated: versions.length === VERSION_HISTORY_LIMIT,
  });
}

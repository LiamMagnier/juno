import "server-only";
import { prisma } from "@/lib/prisma";
import { ARTIFACT_SEALED_INCLUDE, serializeArtifact } from "@/lib/serializers";
import { artifactProjectId } from "@/lib/artifact-access";
import { sealArtifactDraft } from "@/lib/artifact-writes";
import { copyIdentifier, copyTitle } from "@/lib/artifact-copy-names";
import type { ClientArtifact } from "@/types/chat";

/*
 * DUPLICATE (PRODUCT_REFOUNDATION §10: "Duplicate/remix and download are
 * standard"). A copy is a new artifact of the owner's with one version — the
 * source's version they chose, or its current one — in the source's project,
 * with no chat, and `derivedFromId`/`derivedFromVersion` recording where it
 * came from. The source is untouched: no link, draft, suggestion or
 * publication carries over, because each of those is a statement about the
 * source, not about a copy of its content.
 *
 * Duplicating is an explicit checkpoint: an unsealed design draft on the
 * source is sealed first, so "the current version" is what the owner sees.
 */

export type DuplicateResult =
  | { ok: true; artifact: ClientArtifact; id: string }
  | { ok: false; error: "not_found" | "no_such_version" };

export async function duplicateArtifact(
  userId: string,
  artifactId: string,
  opts: { version?: number; title?: string } = {}
): Promise<DuplicateResult> {
  const source = await prisma.artifact.findFirst({
    where: { id: artifactId, userId, deletedAt: null },
    select: { id: true },
  });
  if (!source) return { ok: false, error: "not_found" };
  if (opts.version === undefined) await sealArtifactDraft(artifactId, userId);

  const artifact = await prisma.artifact.findFirst({
    where: { id: artifactId, userId, deletedAt: null },
    select: {
      id: true,
      identifier: true,
      title: true,
      type: true,
      language: true,
      currentVersion: true,
      projectId: true,
      conversation: { select: { projectId: true } },
    },
  });
  if (!artifact) return { ok: false, error: "not_found" };
  const version = opts.version ?? artifact.currentVersion;
  const body = await prisma.artifactVersion.findUnique({
    where: { artifactId_version: { artifactId: artifact.id, version } },
    select: { content: true },
  });
  if (!body) return { ok: false, error: "no_such_version" };

  const created = await prisma.artifact.create({
    data: {
      userId,
      projectId: artifactProjectId(artifact),
      conversationId: null,
      identifier: copyIdentifier(artifact.identifier),
      title: opts.title?.trim() || copyTitle(artifact.title),
      type: artifact.type,
      language: artifact.language,
      currentVersion: 1,
      derivedFromId: artifact.id,
      derivedFromVersion: version,
      versions: { create: { version: 1, content: body.content, origin: "edit" } },
    },
    include: ARTIFACT_SEALED_INCLUDE,
  });
  return { ok: true, artifact: serializeArtifact(created), id: created.id };
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { ARTIFACT_SEALED_INCLUDE, serializeArtifact } from "@/lib/serializers";
import { ownedArtifactWhere } from "@/lib/artifact-access";
import { ArtifactNotFoundError, ArtifactVersionConflictError, saveArtifactVersion } from "@/lib/artifact-writes";
import { artifactWriteLimited } from "@/lib/artifact-rate-limit";
import { MAX_ARTIFACT_CONTENT_CHARS } from "@/lib/artifact-content";
import { applySemanticOps, isSemanticArtifactType } from "@/lib/work/deliverables/semantic";
import { SemanticError } from "@/lib/work/deliverables/semantic/shared";

export const runtime = "nodejs";

/**
 * POST /api/artifacts/:id/ops — a person's edit to a workbook, document or deck
 * as semantic operations (typing in a cell, accepting a suggestion, editing a
 * slide's text), applied by the same deterministic engine the chat uses and
 * saved as ONE new version with origin "edit". Undo is the ordinary restore of
 * the previous version; a later model edit over this one is held as a
 * suggestion by the re-emit guard because the head is now a person's edit.
 *
 * `baseVersion` is required: the operations were chosen against what the
 * person saw, and a moved head answers 409 with the current artifact rather
 * than applying them to content they did not see.
 */
const bodySchema = z.object({
  baseVersion: z.number().int().positive(),
  ops: z.array(z.unknown()).min(1).max(60),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await artifactWriteLimited(user, "save");
  if (limited) return limited;

  const { id } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const artifact = await prisma.artifact.findFirst({
    where: ownedArtifactWhere(user.id, { id }),
    select: {
      id: true,
      type: true,
      currentVersion: true,
      versions: { orderBy: { version: "desc" }, take: 1, select: { version: true, content: true } },
    },
  });
  if (!artifact?.versions[0]) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!isSemanticArtifactType(artifact.type)) {
    return NextResponse.json({ error: "Only spreadsheets, documents and decks take operations." }, { status: 400 });
  }
  const latest = async () => {
    const row = await prisma.artifact.findFirst({ where: ownedArtifactWhere(user.id, { id }), include: ARTIFACT_SEALED_INCLUDE });
    return row ? serializeArtifact(row) : null;
  };
  if (artifact.versions[0].version !== parsed.data.baseVersion) {
    return NextResponse.json({ error: "stale", artifact: await latest() }, { status: 409 });
  }

  let result: ReturnType<typeof applySemanticOps>;
  try {
    result = applySemanticOps(artifact.type, artifact.versions[0].content, parsed.data.ops, {
      author: user.name ?? undefined,
    });
  } catch (error) {
    if (error instanceof SemanticError) {
      return NextResponse.json({ error: error.message, code: error.code, opIndex: error.opIndex ?? null }, { status: 422 });
    }
    throw error;
  }
  if (result.content.length > MAX_ARTIFACT_CONTENT_CHARS) {
    return NextResponse.json({ error: "This edit makes the artifact too large to save." }, { status: 413 });
  }

  try {
    await saveArtifactVersion({
      artifactId: artifact.id,
      userId: user.id,
      content: result.content,
      origin: "edit",
      baseVersion: parsed.data.baseVersion,
    });
  } catch (error) {
    if (error instanceof ArtifactNotFoundError) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (error instanceof ArtifactVersionConflictError || (error as { code?: string })?.code === "P2002") {
      return NextResponse.json({ error: "stale", artifact: await latest() }, { status: 409 });
    }
    throw error;
  }

  return NextResponse.json({
    artifact: await latest(),
    changes: result.changes,
    recalculated: result.recalculated ?? [],
    chartsChanged: result.chartsChanged ?? [],
    fit: result.fit ?? [],
  });
}

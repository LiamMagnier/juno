import "server-only";
import { prisma } from "@/lib/prisma";
import { buildSemanticArtifactContext } from "@/lib/artifact-ops";
import { isSemanticArtifactType, outlineSemantic, SEMANTIC_ARTIFACT_TYPES } from "@/lib/work/deliverables/semantic";

/*
 * Pipeline helpers for semantic artifacts (workbooks, documents, decks —
 * src/lib/work/deliverables/semantic): the outlines the prompt carries so an
 * edit is a few operations rather than a regenerated body, and the current
 * version an ops block names (src/lib/artifact-ops.ts).
 */

export function safeOutline(type: string, content: string, maxChars: number): string {
  if (!isSemanticArtifactType(type)) return content;
  try {
    return outlineSemantic(type, content, maxChars);
  } catch {
    return "(this version could not be read)";
  }
}

/** Budget for every outline in one prompt; the most recently updated come first. */
const SEMANTIC_CONTEXT_CHARS = 24_000;

export async function semanticArtifactContext(conversationId: string, userId: string): Promise<string | null> {
  const rows = await prisma.artifact.findMany({
    where: { conversationId, userId, deletedAt: null, type: { in: [...SEMANTIC_ARTIFACT_TYPES] } },
    orderBy: { updatedAt: "desc" },
    take: 4,
    select: { identifier: true, type: true, title: true, currentVersion: true, versions: { orderBy: { version: "desc" }, take: 1, select: { content: true, version: true } } },
  });
  if (!rows.length) return null;
  const budget = Math.floor(SEMANTIC_CONTEXT_CHARS / rows.length);
  return buildSemanticArtifactContext(
    rows
      .filter((row) => row.versions[0])
      .map((row) => ({
        identifier: row.identifier,
        type: row.type,
        title: row.title,
        version: row.versions[0].version,
        outline: safeOutline(row.type, row.versions[0].content, budget),
      }))
  );
}

/** The current version of an artifact an ops block names, in this chat only. */
export async function loadOpsTarget(conversationId: string, identifier: string, userId: string) {
  const row = await prisma.artifact.findFirst({
    where: { conversationId, userId, identifier, deletedAt: null },
    select: { identifier: true, type: true, title: true, currentVersion: true, versions: { orderBy: { version: "desc" }, take: 1, select: { content: true, version: true } } },
  });
  if (!row?.versions[0]) return null;
  return { identifier: row.identifier, type: row.type, title: row.title, version: row.versions[0].version, content: row.versions[0].content };
}

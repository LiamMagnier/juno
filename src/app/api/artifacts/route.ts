import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";

/**
 * How much of an artifact's source rides along for the grid's preview.
 *
 * Enough to fill a tile — roughly twenty lines of code, or a small complete SVG
 * — and no more. The truncation happens in Postgres (`left()`), not in Node: an
 * artifact's content is unbounded `TEXT`, so slicing it here would still pull
 * every byte of two hundred artifacts across the wire to throw almost all of it
 * away.
 */
const PREVIEW_CHARS = 1200;

// All artifacts the user has created across conversations — the Canvas library.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const artifacts = await prisma.artifact.findMany({
    where: { conversation: { userId: user.id } },
    orderBy: { updatedAt: "desc" },
    take: 200,
    select: {
      id: true,
      identifier: true,
      title: true,
      type: true,
      language: true,
      currentVersion: true,
      conversationId: true,
      createdAt: true,
      updatedAt: true,
      conversation: { select: { title: true } },
    },
  });

  /*
   * The head of each artifact's newest version, for the grid.
   *
   * A second query rather than a nested `include`, because Prisma cannot
   * truncate a column: `versions: { take: 1 }` would fetch each artifact's
   * content in full. `DISTINCT ON` picks the highest version per artifact in
   * one pass, which is what `currentVersion` names.
   *
   * Ownership is already established — these ids came from a query scoped to
   * the user's own conversations — and the ids are parameterised, so this
   * cannot widen what the caller can see.
   */
  const previews = new Map<string, string>();
  if (artifacts.length > 0) {
    const rows = await prisma.$queryRaw<{ artifactId: string; preview: string | null }[]>`
      SELECT DISTINCT ON (v."artifactId")
             v."artifactId" AS "artifactId",
             left(v."content", ${PREVIEW_CHARS}) AS "preview"
      FROM "ArtifactVersion" v
      WHERE v."artifactId" IN (${Prisma.join(artifacts.map((a) => a.id))})
      ORDER BY v."artifactId", v."version" DESC
    `;
    for (const row of rows) if (row.preview) previews.set(row.artifactId, row.preview);
  }

  return NextResponse.json({
    items: artifacts.map((a) => ({
      id: a.id,
      identifier: a.identifier,
      title: a.title,
      type: a.type,
      language: a.language,
      version: a.currentVersion,
      conversationId: a.conversationId,
      conversationTitle: a.conversation.title,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
      // Truncated source for the grid tile. Null when the artifact has no
      // stored version yet, which the tile renders as its kind glyph.
      preview: previews.get(a.id) ?? null,
    })),
  });
}

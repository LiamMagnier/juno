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

/**
 * All artifacts the user has created across conversations — the Artifacts
 * home — or, with `?projectId=`, the ones made in that project's chats.
 *
 * The project scope exists for a project's Sources tab, which used to fetch
 * the whole account's list and keep the ones from its chats on the client
 * (X-21). That could only narrow the 200 most recent, so a project whose
 * artifacts were older than the account's latest 200 read short. Scoped here,
 * the 200 are the project's own. It goes through the conversation, as the
 * ownership join does, until an artifact carries its own `projectId`
 * (04-MERGE-PLAN.md §2.6); a project id the user does not own matches nothing,
 * because the conversation must also be theirs.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const projectId = new URL(req.url).searchParams.get("projectId")?.trim() || null;

  const artifacts = await prisma.artifact.findMany({
    where: { conversation: { userId: user.id, ...(projectId ? { projectId } : {}) } },
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
  /*
   * `::int` ON THE LENGTH IS LOAD-BEARING, and its absence broke this page for
   * every account that owned an artifact.
   *
   * Prisma binds a JS number as int8. Postgres has `left(text, integer)` and
   * no `left(text, bigint)`, so the query failed with 42883 and the grid
   * rendered "Couldn't load your artifacts" — but only once you had one,
   * because the guard below skips the query at zero. An empty library looked
   * perfect and a used one did not, which is why it survived.
   *
   * src/lib/search/sql.ts casts every one of these for exactly this reason.
   * This was the one call site that did not.
   */
  //
  // Not for a design. Its source is a DesignDocument, whose head is JSON no tile
  // shows: every surface draws a design from its poster (X-20), so its 1,200
  // characters would be bytes sent to be thrown away.
  const previews = new Map<string, string>();
  const previewed = artifacts.filter((a) => a.type !== "DESIGN");
  if (previewed.length > 0) {
    const rows = await prisma.$queryRaw<{ artifactId: string; preview: string | null }[]>`
      SELECT DISTINCT ON (v."artifactId")
             v."artifactId" AS "artifactId",
             left(v."content", ${PREVIEW_CHARS}::int) AS "preview"
      FROM "ArtifactVersion" v
      WHERE v."artifactId" IN (${Prisma.join(previewed.map((a) => a.id))})
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
      // stored version yet, which the tile renders as its kind glyph, and
      // always for a design, which the tile draws from its poster.
      preview: previews.get(a.id) ?? null,
    })),
  });
}

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { ownedArtifactWhere } from "@/lib/artifact-access";
import { nextVersionCursor, parseVersionPageQuery } from "@/lib/artifact-version-pages";

export const runtime = "nodejs";

type VersionOrigin = "generated" | "edit" | "restore" | null;

function origin(raw: string | null): VersionOrigin {
  return raw === "generated" || raw === "edit" || raw === "restore" ? raw : null;
}

/**
 * One page of an artifact's version history, newest first
 * (src/lib/artifact-version-pages.ts). `?before=<version>&limit=<n>`;
 * `content=1` includes the bodies. `nextBefore` is the cursor for the next
 * page, null at the start of history. `draft` says whether the design editor
 * has an unsealed working copy (it is not a version and is not listed).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const query = parseVersionPageQuery(new URL(req.url).searchParams);
  if (!query) return NextResponse.json({ error: "Invalid page" }, { status: 400 });

  const { id } = await params;
  const artifact = await prisma.artifact.findFirst({
    where: ownedArtifactWhere(user.id, { id }),
    select: { id: true, currentVersion: true, draft: { select: { updatedAt: true } } },
  });
  if (!artifact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const rows = await prisma.artifactVersion.findMany({
    where: { artifactId: artifact.id, ...(query.before !== null ? { version: { lt: query.before } } : {}) },
    orderBy: { version: "desc" },
    take: query.limit,
    select: { version: true, origin: true, createdAt: true, content: query.content },
  });

  return NextResponse.json(
    {
      currentVersion: artifact.currentVersion,
      draft: artifact.draft ? { version: artifact.currentVersion + 1, updatedAt: artifact.draft.updatedAt.toISOString() } : null,
      versions: rows.map((row) => ({
        version: row.version,
        origin: origin(row.origin),
        createdAt: row.createdAt.toISOString(),
        ...(query.content ? { content: (row as { content?: string }).content ?? "" } : {}),
      })),
      nextBefore: nextVersionCursor(rows, query.limit),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

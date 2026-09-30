import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { ownedArtifactWhere } from "@/lib/artifact-access";

export const runtime = "nodejs";

/**
 * One version's body. Versions are immutable, so a version older than the
 * head is cacheable by the browser for good; the head may still be followed
 * by a newer one and is not.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; version: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, version: rawVersion } = await params;
  if (!/^\d+$/.test(rawVersion)) return NextResponse.json({ error: "Invalid version" }, { status: 400 });
  const version = Number(rawVersion);
  if (!Number.isSafeInteger(version) || version < 1) return NextResponse.json({ error: "Invalid version" }, { status: 400 });

  const artifact = await prisma.artifact.findFirst({
    where: ownedArtifactWhere(user.id, { id }),
    select: { id: true, currentVersion: true },
  });
  if (!artifact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const row = await prisma.artifactVersion.findUnique({
    where: { artifactId_version: { artifactId: artifact.id, version } },
    select: { version: true, origin: true, content: true, createdAt: true },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const sealed = version < artifact.currentVersion;
  return NextResponse.json(
    { version: { version: row.version, origin: row.origin, content: row.content, createdAt: row.createdAt.toISOString() } },
    { headers: { "Cache-Control": sealed ? "private, max-age=31536000, immutable" : "private, no-cache" } }
  );
}

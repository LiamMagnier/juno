import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { ownedArtifactWhere } from "@/lib/artifact-access";

export const runtime = "nodejs";

/**
 * One version's body.
 *
 * Never stored by the browser, although a version never changes: a version
 * can still be DELETED ("Delete now", the trash purge, account deletion), and
 * a year-long cache entry would keep its body on the device after the person
 * erased it, readable to whoever uses the browser next without asking the
 * server. Bodies are fetched one at a time on demand, so the cost is small.
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
    select: { id: true },
  });
  if (!artifact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const row = await prisma.artifactVersion.findUnique({
    where: { artifactId_version: { artifactId: artifact.id, version } },
    select: { version: true, origin: true, content: true, createdAt: true },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json(
    { version: { version: row.version, origin: row.origin, content: row.content, createdAt: row.createdAt.toISOString() } },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { serializeArtifact } from "@/lib/serializers";

const postSchema = z.object({
  content: z.string().max(200_000),
  /** The currentVersion the client was editing. When present and stale, the
   *  save is rejected with 409 + the latest artifact instead of silently
   *  appending on top of a version the user never saw. */
  baseVersion: z.number().int().positive().optional(),
  /** How this version came to be. Manual saves are "edit"; restoring an older
   *  version is "restore". Generated versions are written server-side only. */
  origin: z.enum(["edit", "restore"]).default("edit"),
});

const patchSchema = z.object({ title: z.string().trim().min(1).max(200) });

async function ownedArtifact(id: string, userId: string) {
  return prisma.artifact.findFirst({
    where: { id, conversation: { userId } },
    include: { versions: true },
  });
}

/** Fetch one artifact with full version history (library actions need content). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const artifact = await ownedArtifact(id, user.id);
  if (!artifact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ artifact: serializeArtifact(artifact) });
}

/** Save a manual edit (or restore) as a new artifact version. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const artifact = await ownedArtifact(id, user.id);
  if (!artifact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  if (parsed.data.baseVersion != null && parsed.data.baseVersion !== artifact.currentVersion) {
    return NextResponse.json(
      { error: "stale", artifact: serializeArtifact(artifact) },
      { status: 409 }
    );
  }

  // Transaction: version insert + currentVersion bump land together (see
  // artifacts-store.ts). A concurrent writer hits the (artifactId, version)
  // unique constraint and the whole save rolls back cleanly.
  const nextVersion = artifact.currentVersion + 1;
  const [, updated] = await prisma.$transaction([
    prisma.artifactVersion.create({
      data: {
        artifactId: artifact.id,
        version: nextVersion,
        content: parsed.data.content,
        origin: parsed.data.origin,
      },
    }),
    prisma.artifact.update({
      where: { id: artifact.id },
      data: { currentVersion: nextVersion },
      include: { versions: true },
    }),
  ]).catch((err: unknown) => {
    // Unique-constraint race: someone else appended first. Surface as stale.
    if (typeof err === "object" && err && (err as { code?: string }).code === "P2002") return [null, null] as const;
    throw err;
  });
  if (!updated) {
    const latest = await ownedArtifact(id, user.id);
    return NextResponse.json(
      { error: "stale", artifact: latest ? serializeArtifact(latest) : null },
      { status: 409 }
    );
  }

  return NextResponse.json({ artifact: serializeArtifact(updated) });
}

/** Rename an artifact (title only — content changes go through versions). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const artifact = await ownedArtifact(id, user.id);
  if (!artifact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const updated = await prisma.artifact.update({
    where: { id: artifact.id },
    data: { title: parsed.data.title },
    include: { versions: true },
  });
  return NextResponse.json({ artifact: serializeArtifact(updated) });
}

/** Delete an artifact and its history. Share links cascade with the row. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const artifact = await prisma.artifact.findFirst({
    where: { id, conversation: { userId: user.id } },
    select: { id: true },
  });
  if (!artifact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.artifact.delete({ where: { id: artifact.id } });
  return NextResponse.json({ ok: true });
}

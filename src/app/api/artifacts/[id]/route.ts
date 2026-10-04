import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { ARTIFACT_SEALED_INCLUDE, serializeArtifact } from "@/lib/serializers";
import { ownedArtifactWhere } from "@/lib/artifact-access";
import { ArtifactNotFoundError, ArtifactVersionConflictError, saveArtifactVersion } from "@/lib/artifact-writes";
import { purgeTrashedArtifact, trashArtifact } from "@/lib/artifact-trash";
import { artifactWriteLimited } from "@/lib/artifact-rate-limit";
import { MAX_ARTIFACT_CONTENT_CHARS, storableContent } from "@/lib/artifact-content";

export const runtime = "nodejs";

const postSchema = z.object({
  content: z.string().max(MAX_ARTIFACT_CONTENT_CHARS),
  /** The version the client was editing. When present and not the head (after
   *  any unsealed draft is sealed), the save is refused with 409 and the
   *  current artifact instead of landing on top of a version the person never
   *  saw. Absent (clients too old to send it): last writer wins, as a NEW
   *  version — no existing version is ever overwritten. */
  baseVersion: z.number().int().positive().optional(),
  /** How this version came to be. Manual saves are "edit"; restoring an older
   *  version is "restore". Generated versions are written server-side only. */
  origin: z.enum(["edit", "restore"]).default("edit"),
});

const patchSchema = z.object({ title: z.string().trim().min(1).max(200) });

async function ownedArtifact(id: string, userId: string) {
  return prisma.artifact.findFirst({
    where: ownedArtifactWhere(userId, { id }),
    include: ARTIFACT_SEALED_INCLUDE,
  });
}

/**
 * One artifact with its newest ARTIFACT_VERSION_WINDOW versions (older ones
 * page in from ./versions). Sealed versions only: the installed apps read this
 * and must never cache a draft under a version number.
 */
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

  const limited = await artifactWriteLimited(user, "save");
  if (limited) return limited;

  const { id } = await params;
  const artifact = await prisma.artifact.findFirst({
    where: ownedArtifactWhere(user.id, { id }),
    select: { id: true, type: true },
  });
  if (!artifact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  // A design body must be a document the editor can open (audit B2): this is
  // the route restore and the Mac and iPhone Save write a whole design through.
  const body = storableContent(artifact.type, parsed.data.content);
  if (!body.ok) return NextResponse.json({ error: body.error, code: artifact.type === "DESIGN" ? "invalid_design" : "invalid_body", issues: body.issues }, { status: 422 });

  try {
    await saveArtifactVersion({
      artifactId: artifact.id,
      userId: user.id,
      content: body.content,
      origin: parsed.data.origin,
      baseVersion: parsed.data.baseVersion ?? null,
    });
  } catch (error) {
    if (error instanceof ArtifactNotFoundError) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (error instanceof ArtifactVersionConflictError || isUniqueRace(error)) {
      const latest = await ownedArtifact(id, user.id);
      return NextResponse.json(
        { error: "stale", artifact: latest ? serializeArtifact(latest) : null },
        { status: 409 }
      );
    }
    throw error;
  }

  const updated = await ownedArtifact(id, user.id);
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ artifact: serializeArtifact(updated) });
}

function isUniqueRace(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

/** Rename an artifact (title only — content changes go through versions). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await artifactWriteLimited(user, "save");
  if (limited) return limited;

  const { id } = await params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const renamed = await prisma.artifact.updateMany({
    where: ownedArtifactWhere(user.id, { id }),
    data: { title: parsed.data.title },
  });
  if (renamed.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const updated = await ownedArtifact(id, user.id);
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ artifact: serializeArtifact(updated) });
}

/**
 * Delete an artifact: it moves to Recently deleted (src/lib/artifact-trash.ts)
 * and its public links answer "link gone" until it is restored. Idempotent,
 * so the apps can retry a delete that timed out. `?now=1` removes one that is
 * already in Recently deleted for good ("Delete now"); on a live artifact it
 * is refused with `not_in_trash`, so nothing skips the trash by accident.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await artifactWriteLimited(user, "delete");
  if (limited) return limited;

  const { id } = await params;
  if (new URL(req.url).searchParams.get("now") === "1") {
    const purged = await purgeTrashedArtifact(user.id, id);
    if (purged.ok) return NextResponse.json({ ok: true, deleted: true });
    if (purged.error === "not_found") return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ error: "Move it to Recently deleted first.", code: "not_in_trash" }, { status: 409 });
  }

  const trashed = await trashArtifact(user.id, id);
  if (!trashed) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({
    ok: true,
    trashed: true,
    deletedAt: trashed.deletedAt.toISOString(),
    purgeAt: trashed.purgeAt.toISOString(),
  });
}

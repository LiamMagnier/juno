import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { ARTIFACT_CLIENT_INCLUDE, serializeArtifact } from "@/lib/serializers";
import { artifactTrashEnabled } from "@/lib/artifact-flags";
import { purgeArtifacts, trashArtifact } from "@/lib/artifact-trash";

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

/**
 * One of the user's LIVE artifacts. A trashed one is not found: it cannot be
 * opened, saved or renamed until it is restored, so a native editor holding a
 * stale row reports "no longer available", exactly as it did after a hard
 * delete. Restore and the trash list reach trashed rows on their own.
 */
async function ownedArtifact(id: string, userId: string) {
  return prisma.artifact.findFirst({
    where: { id, conversation: { userId }, deletedAt: null },
    include: ARTIFACT_CLIENT_INCLUDE,
  });
}

function prismaCode(err: unknown): string | undefined {
  return typeof err === "object" && err ? (err as { code?: string }).code : undefined;
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
  // unique constraint and the whole save rolls back cleanly. The bump only
  // matches a live row, so a save racing a delete fails whole (P2025) rather
  // than writing a version into Recently deleted.
  const nextVersion = artifact.currentVersion + 1;
  const outcome = await prisma
    .$transaction([
      prisma.artifactVersion.create({
        data: {
          artifactId: artifact.id,
          version: nextVersion,
          content: parsed.data.content,
          origin: parsed.data.origin,
        },
      }),
      prisma.artifact.update({
        where: { id: artifact.id, deletedAt: null },
        data: { currentVersion: nextVersion },
        include: ARTIFACT_CLIENT_INCLUDE,
      }),
    ])
    .then(
      ([, updated]) => ({ updated }),
      (err: unknown) => {
        // Unique-constraint race: someone else appended first. Surface as stale.
        if (prismaCode(err) === "P2002") return { updated: null };
        // Trashed between the read and the write.
        if (prismaCode(err) === "P2025") return { gone: true as const };
        throw err;
      }
    );
  if ("gone" in outcome) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!outcome.updated) {
    const latest = await ownedArtifact(id, user.id);
    return NextResponse.json(
      { error: "stale", artifact: latest ? serializeArtifact(latest) : null },
      { status: 409 }
    );
  }

  return NextResponse.json({ artifact: serializeArtifact(outcome.updated) });
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

  const updated = await prisma.artifact
    .update({
      where: { id: artifact.id, deletedAt: null },
      data: { title: parsed.data.title },
      include: ARTIFACT_CLIENT_INCLUDE,
    })
    .catch((err: unknown) => {
      // Trashed between the read and the write.
      if (prismaCode(err) === "P2025") return null;
      throw err;
    });
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ artifact: serializeArtifact(updated) });
}

/**
 * Delete an artifact.
 *
 *  - Plain DELETE moves it to Recently deleted: `{ ok, trashed: true, purgeAt }`.
 *    Its versions, its chat and its share rows are untouched; the public link
 *    stops serving until it is restored (`POST …/restore`). Deleting one that
 *    is already trashed answers the same, with the purge date it already had:
 *    the Mac and iPhone retry a delete that timed out, and the retry must not
 *    read as a failure.
 *  - `?now=1` is "Delete now" from Recently deleted: the row, every version
 *    and its links, for good. Only a trashed row; a live one is 409
 *    `not_in_trash`, so a stray query string can never skip the 30 days.
 *  - With `JUNO_ARTIFACTS_TRASH=0` a plain DELETE is the hard delete it was
 *    before R1: `{ ok, trashed: false }`. Rows already trashed stay trashed.
 *
 * Every hard delete goes through `purgeArtifacts`, the one module allowed to
 * issue them (tests/artifact-trash.test.ts).
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const artifact = await prisma.artifact.findFirst({
    where: { id, conversation: { userId: user.id } },
    select: { id: true, deletedAt: true },
  });
  if (!artifact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (new URL(req.url).searchParams.get("now") === "1") {
    if (!artifact.deletedAt) return NextResponse.json({ error: "not_in_trash" }, { status: 409 });
    const purged = await prisma.$transaction((tx) => purgeArtifacts(tx, [artifact.id], { requireTrashed: true }));
    if (purged === 0) {
      // Nothing matched under the lock: either it was restored a moment ago
      // (live again, so 409 like any live row) or a twin request purged it
      // first (gone, which is what was asked).
      const still = await prisma.artifact.findFirst({
        where: { id: artifact.id, conversation: { userId: user.id } },
        select: { id: true },
      });
      if (still) return NextResponse.json({ error: "not_in_trash" }, { status: 409 });
    }
    return NextResponse.json({ ok: true, deleted: true });
  }

  if (!artifactTrashEnabled()) {
    await prisma.$transaction((tx) => purgeArtifacts(tx, [artifact.id], { requireTrashed: false }));
    return NextResponse.json({ ok: true, trashed: false });
  }

  const trashed = await trashArtifact(user.id, artifact.id);
  if (!trashed) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true, trashed: true, purgeAt: trashed.purgeAt.toISOString() });
}

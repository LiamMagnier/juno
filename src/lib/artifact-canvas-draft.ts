import "server-only";

import { prisma } from "@/lib/prisma";
import { ownedArtifactWhere } from "@/lib/artifact-access";
import { MAX_ARTIFACT_CONTENT_CHARS } from "@/lib/artifact-content";

/*
 * THE CANVAS'S UNSAVED EDITS (G12: never lose canvas edits).
 *
 * The canvas's Code tab is always writable on the latest version, and until
 * this existed what a person typed there lived only in React state: closing
 * the panel, opening another artifact, a reload or a crash threw it away
 * without a word. Now the canvas writes the edit here as they type (after the
 * browser's own copy, which is the first and fastest write), offers it back
 * when the artifact reopens — on this device or another — and drops it when
 * they save it as a version or discard it.
 *
 * WHY NOT `ArtifactDraft`. That row is the design editor's working copy, and
 * two rules hold it up (src/lib/artifact-writes.ts): every other write seals it
 * into a version first, and the idle sweeper seals it after two minutes. Both
 * are right for a design, whose gestures ARE the edit. Both are wrong for half
 * a line of code: it would become a version — synced, servable by a
 * publication that follows latest, and the base the next AI edit reads —
 * because the person paused or because the model answered. A canvas draft is
 * only ever turned into a version by the person pressing Save.
 *
 * WHAT IT DOES NOT DO. It never touches the artifact's head, its versions, its
 * sync feed or its publications, and it never merges: `baseVersion` records
 * where the edit started, and the save that eventually carries it names that
 * base, so a head that moved meanwhile is the same 409 ("Saved elsewhere…
 * Discard my draft / Save anyway") a live edit meets.
 */

/** A draft nobody has touched in this long is dropped the next time its owner writes or reads one. */
export const CANVAS_DRAFT_RETENTION_DAYS = 30;

const RETENTION_MS = CANVAS_DRAFT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export interface CanvasDraftView {
  content: string;
  baseVersion: number;
  updatedAt: string;
}

export type CanvasDraftWriteError = "not_found" | "design" | "too_large" | "future_base";

/** True when a draft last written at `updatedAt` is past retention at `now`. */
export function canvasDraftExpired(updatedAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - updatedAt.getTime() > RETENTION_MS;
}

function view(row: { content: string; baseVersion: number; updatedAt: Date }): CanvasDraftView {
  return { content: row.content, baseVersion: row.baseVersion, updatedAt: row.updatedAt.toISOString() };
}

async function ownedArtifact(userId: string, artifactId: string) {
  return prisma.artifact.findFirst({
    where: ownedArtifactWhere(userId, { id: artifactId }),
    select: { id: true, type: true, currentVersion: true },
  });
}

/** Drops this person's drafts that are past retention. Owner-scoped, so it never reaches anyone else's. */
async function dropExpired(userId: string, now: Date): Promise<void> {
  await prisma.artifactCanvasDraft.deleteMany({
    where: { userId, updatedAt: { lt: new Date(now.getTime() - RETENTION_MS) } },
  });
}

/**
 * The person's unsaved edit to this artifact, or null. `not_found` when the
 * artifact is not theirs (or is in Recently deleted), so a route answers 404
 * without saying whether it exists.
 */
export async function readCanvasDraft(
  userId: string,
  artifactId: string,
  now: Date = new Date()
): Promise<CanvasDraftView | null | "not_found"> {
  const artifact = await ownedArtifact(userId, artifactId);
  if (!artifact) return "not_found";
  const row = await prisma.artifactCanvasDraft.findFirst({
    where: { artifactId: artifact.id, userId },
    select: { content: true, baseVersion: true, updatedAt: true },
  });
  if (!row) return null;
  if (canvasDraftExpired(row.updatedAt, now)) {
    await prisma.artifactCanvasDraft.deleteMany({ where: { artifactId: artifact.id, userId } });
    return null;
  }
  return view(row);
}

/**
 * Write (or replace) the person's unsaved edit. One row per person and
 * artifact: the last write wins, which is right for one person typing — two of
 * their own tabs on one artifact meet at Save, where the base check decides.
 */
export async function writeCanvasDraft(
  userId: string,
  artifactId: string,
  input: { content: string; baseVersion: number },
  now: Date = new Date()
): Promise<{ ok: true; draft: CanvasDraftView } | { ok: false; error: CanvasDraftWriteError }> {
  if (input.content.length > MAX_ARTIFACT_CONTENT_CHARS) return { ok: false, error: "too_large" };
  const artifact = await ownedArtifact(userId, artifactId);
  if (!artifact) return { ok: false, error: "not_found" };
  // A design changes only through validated operations, and its working copy
  // is ArtifactDraft, written by the editor's transactions.
  if (artifact.type === "DESIGN") return { ok: false, error: "design" };
  // An edit cannot start from a version that does not exist yet.
  if (input.baseVersion > artifact.currentVersion) return { ok: false, error: "future_base" };

  const row = await prisma.artifactCanvasDraft.upsert({
    where: { artifactId_userId: { artifactId: artifact.id, userId } },
    create: { artifactId: artifact.id, userId, baseVersion: input.baseVersion, content: input.content },
    update: { baseVersion: input.baseVersion, content: input.content },
    select: { content: true, baseVersion: true, updatedAt: true },
  });
  await dropExpired(userId, now).catch(() => {});
  return { ok: true, draft: view(row) };
}

/** Throw the person's unsaved edit away. Idempotent; false when there was none (or no such artifact). */
export async function deleteCanvasDraft(userId: string, artifactId: string): Promise<boolean | "not_found"> {
  const artifact = await ownedArtifact(userId, artifactId);
  if (!artifact) return "not_found";
  const removed = await prisma.artifactCanvasDraft.deleteMany({ where: { artifactId: artifact.id, userId } });
  return removed.count > 0;
}

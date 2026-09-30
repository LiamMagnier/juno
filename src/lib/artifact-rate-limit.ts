import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { isOwnerEmail } from "@/lib/owner";

/*
 * Budgets for the artifact write routes (audit B6, X-33). Every one of them
 * used to be unlimited while each write stored a document-sized row, so one
 * account could fill the database or the sync feed in a loop.
 *
 * Sized for a person working fast, not for a script: the design editor's
 * transaction budget allows ten gestures a second sustained for a minute, a
 * save budget two a second. The owner account is exempt, as it is on the
 * poster and export routes.
 */
export const ARTIFACT_WRITE_BUDGETS = {
  /** Manual saves, restores, renames, checkpoints, suggestion apply/dismiss. */
  save: { limit: 120, windowSec: 60 },
  /** Design editor transactions (gesture rate). */
  transaction: { limit: 600, windowSec: 60 },
  /** Trash, restore, Delete now. */
  delete: { limit: 60, windowSec: 60 },
  /** Publish, update, roll back, unpublish, reset link; creating a share link. */
  publish: { limit: 30, windowSec: 60 },
  /** Duplicate and New design: each makes a new artifact. */
  create: { limit: 30, windowSec: 60 },
  /** File and ZIP downloads (CPU for the archive). */
  download: { limit: 120, windowSec: 3600 },
} as const;

export type ArtifactWriteBucket = keyof typeof ARTIFACT_WRITE_BUDGETS;

/**
 * The 429 to return when `user` is over the bucket's budget, or null to go on.
 */
export async function artifactWriteLimited(
  user: { id: string; email?: string | null },
  bucket: ArtifactWriteBucket
): Promise<NextResponse | null> {
  if (isOwnerEmail(user.email)) return null;
  const budget = ARTIFACT_WRITE_BUDGETS[bucket];
  const result = await rateLimit({ key: `artifact-${bucket}:${user.id}`, limit: budget.limit, windowSec: budget.windowSec });
  if (result.success) return null;
  const retryAfter = Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000));
  return NextResponse.json(
    { error: "Too many changes at once. Try again shortly.", code: "rate_limited" },
    { status: 429, headers: { "Retry-After": String(retryAfter) } }
  );
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { commitTransaction, documentFromArtifact, loadOwnedDesignArtifact, serializeDesignArtifact } from "@/lib/design/store";
import { designTransactionSchema } from "@/lib/design/operations";
import { DesignValidationError } from "@/lib/design/schema";

export const runtime = "nodejs";

const bodySchema = z.object({
  transaction: designTransactionSchema,
  /** "edit" for a normal change, "restore" when re-applying an earlier state.
   *  Feeds the same origin badge the rest of the version history uses. */
  origin: z.enum(["edit", "restore"]).default("edit"),
});

/**
 * Apply one validated transaction to a design document.
 *
 * This is the only write path. There is deliberately no "replace the document"
 * endpoint: a client that could PUT a whole scene could also PUT one the
 * operation layer never checked, and the undo stack would have nothing to
 * invert. Every change — a drag, a keyboard nudge, an accepted AI proposal —
 * arrives here as operations against a named `baseRevision`.
 *
 * A stale `baseRevision` returns 409 with the current document, so the client
 * can show what changed rather than silently clobbering it.
 */
export async function POST(req: Request, { params }: { params: Promise<{ artifactId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { artifactId } = await params;
  const artifact = await loadOwnedDesignArtifact(artifactId, user.id);
  if (!artifact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid transaction", issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`) },
      { status: 400 }
    );
  }

  try {
    const outcome = await commitTransaction(artifact, parsed.data.transaction, parsed.data.origin);
    if (!outcome.ok) {
      return NextResponse.json(
        { error: outcome.message, code: outcome.code, document: outcome.document ?? null },
        { status: outcome.code === "conflict" ? 409 : outcome.code === "too-large" ? 413 : 400 }
      );
    }
    return NextResponse.json({
      artifact: serializeDesignArtifact(outcome.artifact),
      document: outcome.document,
      // The inverse travels back with the result so an undo needs no second
      // round trip and cannot be computed from a document the client has since
      // changed underneath itself.
      undo: outcome.undo,
      touchedNodeIds: outcome.result.touchedNodeIds,
      summaries: outcome.result.summaries,
    });
  } catch (error) {
    if (error instanceof DesignValidationError) {
      return NextResponse.json({ error: error.message, issues: error.issues }, { status: 422 });
    }
    throw error;
  }
}

/** Current document + revision, for a client re-syncing after a conflict. */
export async function GET(_req: Request, { params }: { params: Promise<{ artifactId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { artifactId } = await params;
  const artifact = await loadOwnedDesignArtifact(artifactId, user.id);
  if (!artifact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const document = documentFromArtifact(artifact);
    return NextResponse.json({ revision: document.revision, currentVersion: artifact.currentVersion });
  } catch (error) {
    if (error instanceof DesignValidationError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    throw error;
  }
}

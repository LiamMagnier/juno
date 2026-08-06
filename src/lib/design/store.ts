import "server-only";

/**
 * Server-side persistence for design documents.
 *
 * A design document is an ordinary `Artifact` of type `DESIGN` whose version
 * bodies are the document JSON. Nothing new is stored: history, restore, diff,
 * sharing, the library and deletion are the artifact system's, unchanged. What
 * this module adds is the design-specific *write* rule — an edit is a validated
 * transaction against a named revision, not a blob replacement — and the
 * ownership check every route needs before it will honour one.
 */

import type { Artifact, ArtifactVersion } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  allocatesCheckpoint,
  applyTransaction,
  designTransactionSchema,
  DesignOperationError,
  invertTransaction,
  type DesignTransaction,
  type TransactionResult,
} from "@/lib/design/operations";
import { parseStoredDesignDocument, serializeDesignDocument } from "@/lib/design/migrations";
import { DesignValidationError } from "@/lib/design/schema";
import type { DesignDocument } from "@/lib/design/types";

export type OwnedArtifact = Artifact & { versions: ArtifactVersion[] };

/** Artifacts are owned through their conversation — the same join every other
 *  artifact route uses, so design inherits exactly one ownership model. */
export async function loadOwnedDesignArtifact(artifactId: string, userId: string): Promise<OwnedArtifact | null> {
  const artifact = await prisma.artifact.findFirst({
    where: { id: artifactId, type: "DESIGN", conversation: { userId } },
    include: { versions: { orderBy: { version: "asc" } } },
  });
  return artifact ?? null;
}

/** The row holding the document as it stands now — the one an edit rewrites
 *  when it is folded into the current checkpoint rather than given its own. */
function currentVersionRow(artifact: OwnedArtifact): ArtifactVersion | null {
  return artifact.versions.find((v) => v.version === artifact.currentVersion) ?? artifact.versions.at(-1) ?? null;
}

export function documentFromArtifact(artifact: OwnedArtifact, version?: number): DesignDocument {
  const row =
    version === undefined
      ? currentVersionRow(artifact)
      : artifact.versions.find((v) => v.version === version) ?? artifact.versions.at(-1) ?? null;
  if (!row) throw new DesignValidationError("This design artifact has no versions.");
  return parseStoredDesignDocument(row.content);
}

export type CommitOutcome =
  | { ok: true; artifact: OwnedArtifact; document: DesignDocument; result: TransactionResult; undo: DesignTransaction }
  | { ok: false; code: "conflict" | "invalid" | "too-large"; message: string; document?: DesignDocument };

/** Documents share the artifact body's 200 000-character budget; the check is
 *  here so a runaway transaction is refused with a clear reason rather than by
 *  a database error. */
const MAX_DOCUMENT_BYTES = 200_000;

/**
 * Apply a transaction and persist the result.
 *
 * "Persist" is two different things, and keeping them apart is the point. The
 * *current document* is what the next read must return, and it changes on every
 * gesture. A *checkpoint* is a row in the version history that a person might
 * one day restore, and it should change when the work does — not forty times
 * while a rectangle is dragged across the canvas. Writing a new row per
 * transaction gave every drag, nudge, recolour and rename a permanent copy of
 * the whole document, which cost a document-sized row per interaction and left
 * a history nobody could read.
 *
 * So an edit that continues the run the newest checkpoint already covers
 * rewrites that row in place, and anything else — the first edit after a pause,
 * a restore, a change Juno authored, the first edit on top of generated output
 * — allocates a new one. `allocatesCheckpoint` holds the rule; this function
 * only carries it out.
 *
 * Conflict handling is honest at every layer: the transaction is refused if its
 * `baseRevision` is not the document's current revision, an insert is refused
 * if another writer appended first, and an in-place rewrite is refused if the
 * body it was computed from is no longer the one stored. None of the three
 * rebases — the caller is told the document moved and shown the current one.
 */
export async function commitTransaction(
  artifact: OwnedArtifact,
  transaction: DesignTransaction,
  origin: "edit" | "restore" = "edit"
): Promise<CommitOutcome> {
  const parsed = designTransactionSchema.safeParse(transaction);
  if (!parsed.success) {
    return { ok: false, code: "invalid", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }

  let document: DesignDocument;
  try {
    document = documentFromArtifact(artifact);
  } catch (error) {
    return { ok: false, code: "invalid", message: error instanceof Error ? error.message : "Unreadable design document." };
  }

  let result: TransactionResult;
  try {
    result = applyTransaction(document, transaction);
  } catch (error) {
    if (error instanceof DesignOperationError) {
      return { ok: false, code: error.code === "conflict" ? "conflict" : "invalid", message: error.message, document };
    }
    if (error instanceof DesignValidationError) return { ok: false, code: "invalid", message: error.message, document };
    throw error;
  }

  const content = serializeDesignDocument(result.document);
  if (content.length > MAX_DOCUMENT_BYTES) {
    return { ok: false, code: "too-large", message: "This change would make the document too large to save.", document };
  }

  const latest = currentVersionRow(artifact);
  const folds =
    latest !== null &&
    !allocatesCheckpoint({ origin: latest.origin, ageMs: Date.now() - latest.createdAt.getTime() }, transaction, origin);

  const written = folds && latest ? await rewriteVersion(artifact, latest, content) : await appendVersion(artifact, content, origin);

  if (!written) {
    const current = await prisma.artifact.findFirst({
      where: { id: artifact.id },
      include: { versions: { orderBy: { version: "asc" } } },
    });
    return {
      ok: false,
      code: "conflict",
      message: "The document was saved elsewhere while this change was in flight.",
      document: current ? documentFromArtifact(current) : document,
    };
  }

  return {
    ok: true,
    artifact: written,
    document: result.document,
    result,
    undo: invertTransaction(result, transaction, new Date().toISOString()),
  };
}

/** Raised inside an interactive transaction to roll it back; never escapes. */
class VersionRaced extends Error {}

/** Give the transaction a checkpoint of its own. Null means another writer
 *  appended first. */
async function appendVersion(artifact: OwnedArtifact, content: string, origin: "edit" | "restore"): Promise<OwnedArtifact | null> {
  const nextVersion = artifact.currentVersion + 1;
  const written = await prisma
    .$transaction([
      prisma.artifactVersion.create({
        data: { artifactId: artifact.id, version: nextVersion, content, origin },
      }),
      prisma.artifact.update({
        where: { id: artifact.id },
        data: { currentVersion: nextVersion },
        include: { versions: { orderBy: { version: "asc" } } },
      }),
    ])
    .catch((error: unknown) => {
      // Unique (artifactId, version) race — another writer got there first.
      if (typeof error === "object" && error && (error as { code?: string }).code === "P2002") return null;
      throw error;
    });
  return written ? (written[1] as OwnedArtifact) : null;
}

/** Fold the transaction into the newest checkpoint. Null means the stored body
 *  moved underneath us and the caller must be told rather than overwrite it. */
async function rewriteVersion(artifact: OwnedArtifact, row: ArtifactVersion, content: string): Promise<OwnedArtifact | null> {
  try {
    return await prisma.$transaction(async (tx) => {
      // Compare-and-swap on the body this transaction was computed from. Two
      // editors folding into the same row have no unique constraint to trip, so
      // without this the second write would silently erase the first.
      const swapped = await tx.artifactVersion.updateMany({
        where: { artifactId: artifact.id, version: row.version, content: row.content },
        data: { content },
      });
      if (swapped.count !== 1) throw new VersionRaced();
      // Rewritten to the value it already holds, for the side effect: the
      // artifact's `updatedAt` is how the library and the conversation know
      // this design was worked on, and folding must not make it look idle.
      return await tx.artifact.update({
        where: { id: artifact.id },
        data: { currentVersion: row.version },
        include: { versions: { orderBy: { version: "asc" } } },
      });
    });
  } catch (error) {
    if (error instanceof VersionRaced) return null;
    throw error;
  }
}

/** Public shape returned to clients — the document plus the artifact envelope
 *  the canvas already understands. */
export function serializeDesignArtifact(artifact: OwnedArtifact) {
  return {
    id: artifact.id,
    identifier: artifact.identifier,
    title: artifact.title,
    type: artifact.type,
    language: artifact.language,
    currentVersion: artifact.currentVersion,
    createdAt: artifact.createdAt.toISOString(),
    updatedAt: artifact.updatedAt.toISOString(),
    versions: artifact.versions.map((v) => ({
      version: v.version,
      origin: v.origin,
      createdAt: v.createdAt.toISOString(),
    })),
  };
}

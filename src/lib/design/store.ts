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

export function documentFromArtifact(artifact: OwnedArtifact, version?: number): DesignDocument {
  const target = version ?? artifact.currentVersion;
  const row = artifact.versions.find((v) => v.version === target) ?? artifact.versions.at(-1);
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
 * Apply a transaction and persist the result as a new artifact version.
 *
 * Conflict handling is honest at both layers: the transaction is refused if its
 * `baseRevision` is not the document's current revision, and the version insert
 * is refused if another writer appended first. Neither case rebases — the
 * caller is told the document moved and shown the current one.
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

  if (!written) {
    const latest = await prisma.artifact.findFirst({
      where: { id: artifact.id },
      include: { versions: { orderBy: { version: "asc" } } },
    });
    return {
      ok: false,
      code: "conflict",
      message: "The document was saved elsewhere while this change was in flight.",
      document: latest ? documentFromArtifact(latest) : document,
    };
  }

  return {
    ok: true,
    artifact: written[1] as OwnedArtifact,
    document: result.document,
    result,
    undo: invertTransaction(result, transaction, new Date().toISOString()),
  };
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

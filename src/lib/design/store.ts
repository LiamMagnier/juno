import "server-only";

/**
 * Server-side persistence for design documents.
 *
 * A design document is an ordinary `Artifact` of type `DESIGN` whose version
 * bodies are the document JSON. History, restore, diff, sharing, the library
 * and deletion are the artifact system's. What this module adds is the
 * design-specific *write* rule — an edit is a validated transaction against a
 * named revision, not a blob replacement — and where each transaction lands:
 * the artifact's working copy (`ArtifactDraft`) or a version of its own.
 *
 * Versions are immutable (src/lib/artifact-writes.ts). A run of the person's
 * own gestures folds into the draft, which is sealed into a version when the
 * run pauses (CHECKPOINT_WINDOW_MS, on the next gesture), on an explicit
 * checkpoint, when the editor leaves the page, when the maintenance sweep
 * finds it idle, and before any other write. A restore and a change Juno
 * authored always get a version of their own, after the draft is sealed.
 *
 * Reads never load the whole history: the head's body (or the draft), plus a
 * window of version NUMBERS for the history panel. An earlier body is one
 * indexed read by `(artifactId, version)`.
 */

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
import { ARTIFACT_VERSION_WINDOW } from "@/lib/artifact-access";
import { appendLocked, lockArtifact, sealDraftLocked } from "@/lib/artifact-writes";

export interface DesignVersionMeta {
  version: number;
  origin: string | null;
  createdAt: Date;
}

/** One owned design, as the editor routes need it. */
export interface OwnedDesign {
  id: string;
  userId: string;
  conversationId: string | null;
  identifier: string;
  title: string;
  type: string;
  language: string | null;
  currentVersion: number;
  createdAt: Date;
  updatedAt: Date;
  /** The sealed head's body. Null when a draft is present (not read) or the row has no versions. */
  head: { version: number; content: string } | null;
  /** The working copy, when one is waiting to be sealed. */
  draft: { content: string; updatedAt: Date } | null;
  /** The newest ARTIFACT_VERSION_WINDOW versions' numbers, oldest first. */
  versions: DesignVersionMeta[];
  hasOlderVersions: boolean;
}

/**
 * One of the user's live designs. Owned by the artifact's own `userId`
 * (src/lib/artifact-access.ts), so a design outlives the chat it was made in
 * and a design made outside a chat is as reachable as any other. A trashed
 * design answers null: every editor route 404s until it is restored.
 */
export async function loadOwnedDesignArtifact(artifactId: string, userId: string): Promise<OwnedDesign | null> {
  const artifact = await prisma.artifact.findFirst({
    where: { id: artifactId, type: "DESIGN", userId, deletedAt: null },
    include: {
      versions: {
        select: { version: true, origin: true, createdAt: true },
        orderBy: { version: "desc" },
        take: ARTIFACT_VERSION_WINDOW,
      },
      draft: { select: { content: true, updatedAt: true } },
    },
  });
  if (!artifact) return null;
  const headRow = artifact.draft
    ? null
    : await prisma.artifactVersion.findUnique({
        where: { artifactId_version: { artifactId: artifact.id, version: artifact.currentVersion } },
        select: { version: true, content: true },
      });
  const versions = [...artifact.versions].sort((a, b) => a.version - b.version);
  return {
    id: artifact.id,
    userId,
    conversationId: artifact.conversationId,
    identifier: artifact.identifier,
    title: artifact.title,
    type: artifact.type,
    language: artifact.language,
    currentVersion: artifact.currentVersion,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    head: headRow,
    draft: artifact.draft,
    versions,
    hasOlderVersions: versions.length > 0 && versions[0].version > 1,
  };
}

/**
 * The version number the working copy presents as: the draft will be sealed
 * as exactly `currentVersion + 1`, because every writer seals it first.
 */
export function workingVersionOf(artifact: Pick<OwnedDesign, "currentVersion" | "draft">): number {
  return artifact.draft ? artifact.currentVersion + 1 : artifact.currentVersion;
}

/** The document as the owner's editor sees it now: the draft, else the head. */
export function documentFromArtifact(artifact: OwnedDesign): DesignDocument {
  const content = artifact.draft?.content ?? artifact.head?.content;
  if (content === undefined) throw new DesignValidationError("This design artifact has no versions.");
  return parseStoredDesignDocument(content);
}

/**
 * One version's document, read on its own. The working version answers the
 * working copy; a version that does not exist answers the working copy too, as
 * the history panel always has.
 */
export async function documentAtVersion(artifact: OwnedDesign, version: number): Promise<DesignDocument> {
  if (version === workingVersionOf(artifact)) return documentFromArtifact(artifact);
  const row = await prisma.artifactVersion.findUnique({
    where: { artifactId_version: { artifactId: artifact.id, version } },
    select: { content: true },
  });
  if (!row) return documentFromArtifact(artifact);
  return parseStoredDesignDocument(row.content);
}

export type CommitOutcome =
  | { ok: true; artifact: OwnedDesign; document: DesignDocument; result: TransactionResult; undo: DesignTransaction }
  | { ok: false; code: "conflict" | "invalid" | "too-large" | "not-found"; message: string; document?: DesignDocument };

/** Documents share the artifact body's 200 000-character budget; the check is
 *  here so a runaway transaction is refused with a clear reason rather than by
 *  a database error. */
const MAX_DOCUMENT_BYTES = 200_000;

/** Returned from inside the database transaction to end it without writing. */
type Refusal = Extract<CommitOutcome, { ok: false }>;

/**
 * Apply a transaction and persist the result.
 *
 * Everything happens under the artifact's row lock, so the working copy the
 * transaction is validated against is the one it is written over: no other
 * gesture, save, restore or seal can land in between. The transaction is
 * refused if its `baseRevision` is not the working document's revision — the
 * caller is told the document moved and shown the current one, never rebased.
 *
 * Where it lands (`allocatesCheckpoint`, with the draft as the "latest"):
 *   - the person's gesture inside the fold window → rewrites the draft;
 *   - the first gesture, or one after a pause → seals the draft (if any) into
 *     a version and starts a new draft;
 *   - a restore, or a change Juno authored → seals the draft and appends a
 *     version of its own, the unit a person reviews and reverts.
 *
 * A draft write does not touch the Artifact row (and so syncs nothing); the
 * seal does, which is when the Library and the apps learn the design moved.
 */
export async function commitTransaction(
  artifact: OwnedDesign,
  transaction: DesignTransaction,
  origin: "edit" | "restore" = "edit"
): Promise<CommitOutcome> {
  const parsed = designTransactionSchema.safeParse(transaction);
  if (!parsed.success) {
    return { ok: false, code: "invalid", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }

  const written = await prisma.$transaction(
    async (tx): Promise<{ result: TransactionResult } | Refusal> => {
      const locked = await lockArtifact(tx, artifact.id, { userId: artifact.userId });
      if (!locked) return { ok: false, code: "not-found", message: "This design is no longer available." };
      const draft = await tx.artifactDraft.findFirst({
        where: { artifactId: artifact.id, userId: artifact.userId },
        select: { content: true, updatedAt: true },
      });
      const working =
        draft?.content ??
        (
          await tx.artifactVersion.findUnique({
            where: { artifactId_version: { artifactId: artifact.id, version: locked.currentVersion } },
            select: { content: true },
          })
        )?.content;
      if (working === undefined) return { ok: false, code: "invalid", message: "This design artifact has no versions." };

      let document: DesignDocument;
      try {
        document = parseStoredDesignDocument(working);
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

      const allocates = allocatesCheckpoint(
        draft ? { origin: "edit", ageMs: Date.now() - draft.updatedAt.getTime() } : null,
        transaction,
        origin
      );
      if (!allocates && draft) {
        await tx.artifactDraft.update({
          where: { artifactId: artifact.id, userId: artifact.userId },
          data: { content, revision: { increment: 1 } },
        });
      } else {
        await sealDraftLocked(tx, locked);
        if (transaction.author === "user" && origin === "edit") {
          await tx.artifactDraft.create({
            data: { artifactId: artifact.id, userId: artifact.userId, baseVersion: locked.currentVersion, content },
          });
        } else {
          await appendLocked(tx, locked, { content, origin });
        }
      }
      return { result };
    },
    { timeout: 20_000 }
  );

  if ("ok" in written) return written;

  const fresh = await loadOwnedDesignArtifact(artifact.id, artifact.userId);
  if (!fresh) return { ok: false, code: "not-found", message: "This design is no longer available." };
  return {
    ok: true,
    artifact: fresh,
    document: written.result.document,
    result: written.result,
    undo: invertTransaction(written.result, transaction, new Date().toISOString()),
  };
}

/**
 * Public shape returned to clients — the artifact envelope the canvas already
 * understands. `currentVersion` is the WORKING version (the draft presented as
 * the version it will become), and the version list carries that entry marked
 * `draft: true`, so the editor, the canvas's version rail and a save based on
 * either all agree on one number. `headVersion` is the newest sealed version.
 */
export function serializeDesignArtifact(artifact: OwnedDesign) {
  const working = workingVersionOf(artifact);
  const versions: Array<{ version: number; origin: string | null; createdAt: string; draft?: true }> = artifact.versions.map((v) => ({
    version: v.version,
    origin: v.origin,
    createdAt: v.createdAt.toISOString(),
  }));
  if (artifact.draft) versions.push({ version: working, origin: "edit", createdAt: artifact.draft.updatedAt.toISOString(), draft: true });
  return {
    id: artifact.id,
    identifier: artifact.identifier,
    title: artifact.title,
    type: artifact.type,
    language: artifact.language,
    currentVersion: working,
    headVersion: artifact.currentVersion,
    hasDraft: !!artifact.draft,
    createdAt: artifact.createdAt.toISOString(),
    updatedAt: artifact.updatedAt.toISOString(),
    versions,
    ...(artifact.hasOlderVersions ? { hasOlderVersions: true as const } : {}),
  };
}

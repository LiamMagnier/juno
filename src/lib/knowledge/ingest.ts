/**
 * The ingest state machine: attachment bytes → a KnowledgeDocument and its blocks.
 *
 * The persistence is injected rather than imported. That is not architecture for
 * its own sake — it is the only way this file has tests, because there is no
 * database in the test environment, and the interesting behaviour here is
 * entirely in the decisions (re-index or not? degrade or fail? which version?)
 * rather than in the writes. `src/lib/knowledge/index.ts` supplies the Prisma
 * implementation and is the only place that talks to the database.
 *
 * Every method on the store takes `userId` and every implementation must filter
 * on it. KnowledgeDocument, KnowledgeBlock and KnowledgeIndexJob are all in
 * `OWNER_COLUMN` (see `src/lib/db.ts`): a query here that forgets the owner is
 * one account reading another's documents.
 */

import { createHash } from "node:crypto";
import { PARSER_VERSIONS, extractDocument, selectExtractor } from "./extract";
import type { ExtractedBlock, ExtractionStatus } from "./extract/types";

/* -------------------------------------------------------------------------- */
/* Planning                                                                    */
/* -------------------------------------------------------------------------- */

/** The parts of an existing KnowledgeDocument that the decision depends on. */
export interface KnowledgeDocumentRecord {
  id: string;
  /** queued | extracting | ocr | indexing | ready | degraded | failed | stale */
  state: string;
  version: number;
  parser: string | null;
  parserVersion: string | null;
}

export interface IngestPlan {
  action: "reuse" | "create" | "supersede";
  /** Set only for `reuse` — the document that already covers these bytes. */
  documentId: string | null;
  version: number;
  /** Set only for `supersede` — the document the new one replaces. */
  supersedes: string | null;
}

/**
 * Whether these bytes need indexing, and as which version.
 *
 * The checksum rule the schema asks for ("re-uploading identical bytes must not
 * re-index them") is necessary but not sufficient on its own, because three
 * things can be true of a document with the same checksum:
 *
 * - It finished, on this exact parser version → reuse it. This is the case that
 *   saves the work, and it covers the common one of a user re-attaching a file
 *   they already sent.
 * - It finished, on an older parser → re-index, as a new version. A parser fix
 *   that could not reach documents already indexed would be a fix nobody gets;
 *   the old version stays behind so existing citations still resolve.
 * - It never finished — `queued`, `extracting`, `indexing`, or `failed`. Nothing
 *   is going to come along and complete it, so a re-upload has to be able to.
 *   Without this, a route killed mid-extraction leaves a row that permanently
 *   absorbs every future upload of that file.
 *
 * `degraded` is deliberately treated as finished. A scanned PDF re-extracted by
 * the same parser is still a scanned PDF; retrying buys nothing and costs the
 * same work every time the user re-attaches it.
 */
export function planIngest(input: {
  existing: KnowledgeDocumentRecord | null;
  parser: string;
  parserVersion: string;
}): IngestPlan {
  const { existing } = input;
  if (!existing) return { action: "create", documentId: null, version: 1, supersedes: null };

  const settled = existing.state === "ready" || existing.state === "degraded";
  const sameParser = existing.parser === input.parser && existing.parserVersion === input.parserVersion;
  if (settled && sameParser) {
    return { action: "reuse", documentId: existing.id, version: existing.version, supersedes: null };
  }

  return {
    action: "supersede",
    documentId: null,
    version: existing.version + 1,
    supersedes: existing.id,
  };
}

/** SHA-256 over the raw bytes. Content identity, never the file name. */
export function checksumOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

export interface KnowledgeBlockInput extends ExtractedBlock {
  ordinal: number;
}

export interface CreateDocumentInput {
  userId: string;
  projectId: string | null;
  attachmentId: string | null;
  fileName: string;
  mimeType: string;
  checksum: string;
  version: number;
  parser: string;
  parserVersion: string;
}

export interface UpdateDocumentInput {
  state?: string;
  error?: string | null;
  pageCount?: number | null;
  indexedAt?: Date | null;
  supersededById?: string | null;
}

export interface KnowledgeStore {
  /** Highest-version document for these exact bytes, owned by this user. */
  latestByChecksum(userId: string, checksum: string): Promise<KnowledgeDocumentRecord | null>;
  createDocument(input: CreateDocumentInput): Promise<string>;
  updateDocument(userId: string, documentId: string, patch: UpdateDocumentInput): Promise<void>;
  replaceBlocks(userId: string, documentId: string, blocks: KnowledgeBlockInput[]): Promise<void>;
  createJob(userId: string, documentId: string): Promise<string>;
  updateJob(
    userId: string,
    jobId: string,
    patch: { state: string; error?: string | null; startedAt?: Date; finishedAt?: Date }
  ): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Ingest                                                                      */
/* -------------------------------------------------------------------------- */

export interface IngestInput {
  userId: string;
  attachmentId: string | null;
  projectId: string | null;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

export type IngestOutcome =
  /** No extractor claims this format — images, video, legacy Office. */
  | { status: "skipped"; reason: string }
  /** These exact bytes are already indexed by this parser version. */
  | { status: "reused"; documentId: string }
  | { status: "indexed"; documentId: string; state: ExtractionStatus; blocks: number; error?: string };

/** Files past this are not read into memory at all; the ceiling is the memory bound. */
export const MAX_INGEST_BYTES = 64 * 1024 * 1024;

/**
 * Index one uploaded file.
 *
 * Never throws. Ingest runs after the upload response has already been sent, so
 * a rejection here has nobody to report to — it would surface as an unhandled
 * rejection in a log and the document would sit in `extracting` forever. Every
 * failure path instead lands the document in `failed` with a sentence the user
 * can read, which is the state the UI is built to show.
 */
export async function runIngest(store: KnowledgeStore, input: IngestInput): Promise<IngestOutcome> {
  const extractor = selectExtractor(input.fileName, input.mimeType);
  if (!extractor) {
    return { status: "skipped", reason: "Juno does not index this kind of file yet." };
  }
  if (input.bytes.byteLength > MAX_INGEST_BYTES) {
    return { status: "skipped", reason: "This file is too large to index." };
  }

  const checksum = checksumOf(input.bytes);

  const parserVersion = PARSER_VERSIONS[extractor];

  let existing: KnowledgeDocumentRecord | null = null;
  try {
    existing = await store.latestByChecksum(input.userId, checksum);
  } catch {
    // A read failure must not turn into a duplicate document; treat it as
    // "unknown" and let the unique (userId, checksum, version) index arbitrate.
    existing = null;
  }

  const plan = planIngest({ existing, parser: extractor, parserVersion });
  if (plan.action === "reuse" && plan.documentId) {
    return { status: "reused", documentId: plan.documentId };
  }

  const documentId = await store.createDocument({
    userId: input.userId,
    projectId: input.projectId,
    attachmentId: input.attachmentId,
    fileName: input.fileName,
    mimeType: input.mimeType,
    checksum,
    version: plan.version,
    parser: extractor,
    parserVersion,
  });
  const jobId = await store.createJob(input.userId, documentId);

  try {
    await store.updateDocument(input.userId, documentId, { state: "extracting" });
    await store.updateJob(input.userId, jobId, { state: "running", startedAt: new Date() });

    const result = await extractDocument({
      bytes: input.bytes,
      fileName: input.fileName,
      mimeType: input.mimeType,
    });
    if (!result || result.status === "failed") {
      const error = result?.reason ?? "This file could not be read.";
      await store.updateDocument(input.userId, documentId, { state: "failed", error });
      await store.updateJob(input.userId, jobId, { state: "failed", error, finishedAt: new Date() });
      return { status: "indexed", documentId, state: "failed", blocks: 0, error };
    }

    await store.updateDocument(input.userId, documentId, { state: "indexing" });
    await store.replaceBlocks(
      input.userId,
      documentId,
      result.blocks.map((block, ordinal) => ({ ...block, ordinal }))
    );

    await store.updateDocument(input.userId, documentId, {
      state: result.status === "degraded" ? "degraded" : "ready",
      error: result.reason ?? null,
      pageCount: result.pageCount ?? null,
      indexedAt: new Date(),
    });
    await store.updateJob(input.userId, jobId, { state: "done", finishedAt: new Date() });

    if (plan.supersedes) {
      // The old version is kept, not deleted: a citation into it must keep
      // resolving. `stale` is what tells retrieval to stop preferring it.
      await store.updateDocument(input.userId, plan.supersedes, {
        state: "stale",
        supersededById: documentId,
      });
    }

    return { status: "indexed", documentId, state: result.status, blocks: result.blocks.length, error: result.reason };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Indexing failed unexpectedly.";
    try {
      await store.updateDocument(input.userId, documentId, { state: "failed", error: message });
      await store.updateJob(input.userId, jobId, { state: "failed", error: message, finishedAt: new Date() });
    } catch {
      // The database is unreachable. There is nothing left to record it with.
    }
    return { status: "indexed", documentId, state: "failed", blocks: 0, error: message };
  }
}

/**
 * The database side of knowledge ingest.
 *
 * Everything interesting lives in `./ingest` and `./extract`, which are pure and
 * tested. This file is the thin Prisma adapter plus the entry point the upload
 * routes call, and it is the only module here that imports the client.
 *
 * KnowledgeDocument, KnowledgeBlock and KnowledgeIndexJob are all listed in
 * `OWNER_COLUMN` (`src/lib/db.ts`), so every query below filters on `userId` —
 * including the updates, where an id alone would otherwise be enough to write
 * across accounts.
 */

import "server-only";
import { prisma } from "@/lib/prisma";
import {
  runIngest,
  type IngestInput,
  type IngestOutcome,
  type KnowledgeStore,
} from "./ingest";

export { MAX_INGEST_BYTES, checksumOf, planIngest } from "./ingest";
export type { IngestInput, IngestOutcome } from "./ingest";

const prismaStore: KnowledgeStore = {
  async latestByChecksum(userId, checksum) {
    return prisma.knowledgeDocument.findFirst({
      where: { userId, checksum },
      orderBy: { version: "desc" },
      select: { id: true, state: true, version: true, parser: true, parserVersion: true },
    });
  },

  async createDocument(input) {
    const document = await prisma.knowledgeDocument.create({
      data: {
        userId: input.userId,
        projectId: input.projectId,
        attachmentId: input.attachmentId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        checksum: input.checksum,
        version: input.version,
        parser: input.parser,
        parserVersion: input.parserVersion,
        state: "queued",
      },
      select: { id: true },
    });
    return document.id;
  },

  async updateDocument(userId, documentId, patch) {
    // updateMany, not update: `update` matches on the primary key alone, which
    // would let a document id from another account be written to. The owner
    // predicate has to be part of the WHERE clause, not a check before it.
    await prisma.knowledgeDocument.updateMany({ where: { id: documentId, userId }, data: patch });
  },

  async replaceBlocks(userId, documentId, blocks) {
    await prisma.knowledgeBlock.deleteMany({ where: { userId, documentId } });
    if (!blocks.length) return;
    // Chunked because a single createMany of tens of thousands of rows exceeds
    // Postgres' bind-parameter limit, and the failure mode is the whole document
    // silently having no blocks.
    const CHUNK = 1_000;
    for (let i = 0; i < blocks.length; i += CHUNK) {
      await prisma.knowledgeBlock.createMany({
        data: blocks.slice(i, i + CHUNK).map((block) => ({
          userId,
          documentId,
          ordinal: block.ordinal,
          type: block.type,
          text: block.text,
          page: block.page ?? null,
          slide: block.slide ?? null,
          sheet: block.sheet ?? null,
          cellRange: block.cellRange ?? null,
          path: block.path ?? null,
          lineStart: block.lineStart ?? null,
          lineEnd: block.lineEnd ?? null,
          heading: block.heading,
          bbox: block.bbox ?? [],
          confidence: block.confidence,
        })),
      });
    }
  },

  async createJob(userId, documentId) {
    const job = await prisma.knowledgeIndexJob.create({
      data: { userId, documentId, state: "queued" },
      select: { id: true },
    });
    return job.id;
  },

  async updateJob(userId, jobId, patch) {
    await prisma.knowledgeIndexJob.updateMany({
      where: { id: jobId, userId },
      data: {
        state: patch.state,
        error: patch.error ?? null,
        ...(patch.startedAt ? { startedAt: patch.startedAt, attempts: { increment: 1 } } : {}),
        ...(patch.finishedAt ? { finishedAt: patch.finishedAt } : {}),
      },
    });
  },
};

/**
 * Index an uploaded attachment.
 *
 * Callers do not need to await this for correctness — it reports every failure
 * into the document's own state rather than by rejecting — but they must not
 * float it either. Next's `after()` is the right host: the upload response goes
 * out immediately and the extraction runs on a runtime that is still alive,
 * which a bare floating promise in a serverless handler is not.
 */
export async function ingest(input: IngestInput): Promise<IngestOutcome> {
  return runIngest(prismaStore, input);
}

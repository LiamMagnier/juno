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
import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { logSync } from "@/lib/logger";
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

/**
 * The upload routes' entry point: index this file, after the response.
 *
 * Both `/api/upload` and `/api/v1/attachments` call exactly this, for the same
 * reason they share `planAttachmentUpload` — two copies of "how does an upload
 * get indexed" means only one of them gets fixed. Scheduling lives here rather
 * than in the routes so neither of them can accidentally `await` it and make a
 * user watch a 200-page PDF parse before their file appears.
 *
 * `after()` and not a floating promise: a floating promise in a serverless
 * handler is killed the moment the response is flushed, which would leave the
 * document in `extracting` with nothing left running to move it on.
 */
export function scheduleIngest(input: IngestInput): void {
  after(async () => {
    try {
      const outcome = await ingest(input);
      if (input.attachmentId) {
        const parserState =
          outcome.status === "indexed"
            ? outcome.state
            : outcome.status === "reused"
              ? "ready"
              : outcome.status;
        await prisma.attachment
          .updateMany({ where: { id: input.attachmentId, userId: input.userId }, data: { parserState } })
          .catch((error) => {
            console.error("[knowledge] could not persist attachment parser state", {
              attachmentId: input.attachmentId,
              message: error instanceof Error ? error.message : String(error),
            });
          });
      }
      logSync(outcome.status === "unavailable" ? "warn" : "info", "knowledge.ingest", {
        status: outcome.status,
        fileName: input.fileName,
        attachmentId: input.attachmentId,
        ...(outcome.status === "indexed"
          ? { documentId: outcome.documentId, state: outcome.state, blocks: outcome.blocks }
          : {}),
      });
    } catch (error) {
      // runIngest is written not to throw; if it does, the upload has already
      // succeeded and this must not become an unhandled rejection.
      logSync("error", "knowledge.ingest_crashed", {
        fileName: input.fileName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

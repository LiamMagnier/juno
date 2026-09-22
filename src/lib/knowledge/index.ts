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
 * How much of a document's text is kept on the attachment row.
 *
 * The same 200 000 characters the upload path already stores for a plain text
 * file (`attachment-upload.ts`), so a PDF and a .txt of the same length are
 * treated the same way — there was never a reason for the format to decide how
 * much of a document Juno remembers. Roughly a 200-page report. What a given
 * model is actually sent is a smaller, model-aware slice of this
 * (`attachmentTextBudget`), and `read_document` reaches the rest.
 */
const ATTACHMENT_TEXT_STORE_MAX = 200_000;

/**
 * Put the extracted document text back on the attachment it came from.
 *
 * THE GAP THIS CLOSES. `Attachment.extractedText` is what every provider
 * adapter reads to put a file's contents in front of a model, and the upload
 * path can only fill it for files that are already text — decode the bytes as
 * UTF-8 and store them. A PDF, a deck or a workbook has no such reading, so
 * the column stayed null and the adapters fell back to a bracketed apology
 * ("this model does not receive raw PDF bytes"). The contents were not
 * missing: structured extraction had read the whole document minutes earlier
 * and written it to `KnowledgeBlock`. Nothing joined the two back up, so on
 * every OpenAI-family model an attached PDF reached the conversation as its
 * filename plus whatever four passages retrieval happened to match.
 *
 * ONLY WHEN THE COLUMN IS EMPTY. A text file's own bytes are the better
 * reading of it — block assembly normalises whitespace and interleaves page
 * markers, which is right for a report and wrong for a CSV or a source file.
 * This fills a gap; it never overwrites a reading that already exists.
 */
async function persistExtractedText(input: {
  userId: string;
  attachmentId: string;
  documentId: string;
}): Promise<void> {
  const attachment = await prisma.attachment.findFirst({
    where: { id: input.attachmentId, userId: input.userId },
    select: { id: true, version: true, extractedText: true },
  });
  if (!attachment || attachment.extractedText) return;

  const { readDocumentText } = await import("@/lib/knowledge/documents");
  const assembled = await readDocumentText(input.userId, input.documentId, {
    maxChars: ATTACHMENT_TEXT_STORE_MAX,
  });
  if (!assembled?.text) return;
  // Blocks are sanitised on the way in, but this string is assembled from them
  // and written to a second `text` column; the belt costs one call.
  const { stripUnstorableCharacters } = await import("@/lib/knowledge/extract/types");
  const storable = stripUnstorableCharacters(assembled.text);
  if (!storable) return;

  await prisma.attachment.updateMany({
    where: { id: input.attachmentId, userId: input.userId },
    data: { extractedText: storable },
  });
  // The version row is the one a restore reads back, so it has to carry the
  // same text or restoring a file would quietly un-read it.
  await prisma.attachmentVersion
    .updateMany({
      where: { attachmentId: input.attachmentId, version: attachment.version },
      data: { extractedText: storable },
    })
    .catch(() => undefined);
}

/** How many files one turn will read before it gets on with the answer. */
const READ_PER_TURN = 8;

/**
 * Read the attached files this turn actually needs, now that the turn exists.
 *
 * THIS IS WHERE READING MOVED TO. Nothing is extracted when a file is
 * uploaded any more (`scheduleIngest` refuses a chat attachment outright), so
 * the first turn that carries a document is the first time anything opens it.
 * That ordering is the whole point: by the time this runs there is a question,
 * a model, and a reason — none of which existed at upload, when the old
 * pipeline was busy deciding the file was unreadable.
 *
 * It runs the same `extractDocument` ladder against the stored bytes and
 * caches the result on the row, so a conversation pays for it once rather
 * than on every turn.
 *
 * SKIPPED ENTIRELY WHEN THE MODEL GETS THE FILE ITSELF. Claude, Gemini and the
 * Responses API receive the raw PDF and rasterise every page internally, which
 * is strictly better than any text this could hand them — so extracting for
 * them would be work done twice, and the worse copy would be the one in the
 * prompt.
 *
 * Bounded and never fatal. This sits on the critical path of a generation, and
 * a slow extractor must cost the answer nothing more than the reading it could
 * not supply — the model still has `read_document` and `inspect_image`.
 */
export async function ensureAttachmentText(
  attachments: {
    id: string;
    kind: string;
    fileName: string;
    mimeType: string;
    storageKey: string;
    size: number;
    extractedText: string | null;
  }[],
  options: { skip?: (attachment: { mimeType: string; fileName: string }) => boolean } = {},
): Promise<void> {
  const pending = attachments
    .filter(
      (attachment) =>
        attachment.kind === "FILE" &&
        !attachment.extractedText &&
        !options.skip?.(attachment),
    )
    .slice(0, READ_PER_TURN);
  if (pending.length === 0) return;

  const [{ readAttachmentOnDemand }, { stripUnstorableCharacters }] = await Promise.all([
    import("@/lib/knowledge/read-on-demand"),
    import("@/lib/knowledge/extract/types"),
  ]);

  await Promise.all(
    pending.map(async (attachment) => {
      try {
        const read = await readAttachmentOnDemand(attachment, { maxChars: ATTACHMENT_TEXT_STORE_MAX });
        const text = read?.text ? stripUnstorableCharacters(read.text) : "";
        if (!text) return;
        // The row this turn is about to send, updated in place; the write below
        // is so the next turn does not pay for the same read.
        attachment.extractedText = text;
        await prisma.attachment
          .updateMany({ where: { id: attachment.id }, data: { extractedText: text } })
          .catch(() => undefined);
      } catch (error) {
        console.error("[knowledge] could not read an attachment for this turn", {
          attachmentId: attachment.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
}

export function scheduleIngest(input: IngestInput): void {
  /*
   * A CHAT ATTACHMENT IS NOT INDEXED. THIS IS THE GATE.
   *
   * Eager extraction at upload was the root of a whole class of failure: a
   * parser ran before anyone had asked anything, decided what the file
   * contained, and its verdict stuck — a misjudged PDF was "couldn't read this
   * file" permanently, and one NUL byte failed the insert for a 200-page
   * report. Reading a chat attachment now happens when a question needs it
   * (`ensureAttachmentText`), against the bytes, with the extractors called on
   * demand. Nothing about a file is decided before it is asked about.
   *
   * A PROJECT file is genuinely different and keeps its index: a knowledge
   * base exists to be searched across many documents at once, which is the one
   * thing an index does better than reading, and filing a document there is an
   * explicit request for exactly that.
   *
   * The rule lives here rather than at the five call sites because a caller
   * that forgets it does not fail loudly — it silently re-creates the eager
   * behaviour this was removed to stop.
   */
  if (!input.projectId) return;

  after(async () => {
    try {
      if (input.attachmentId) {
        // Claim the attachment before doing any work. Import recovery uses the
        // same state transition, so a duplicate after() callback or a second
        // worker cannot index the same queued attachment concurrently.
        const claimed = await prisma.attachment.updateMany({
          where: { id: input.attachmentId, userId: input.userId, parserState: "queued" },
          data: { parserState: "indexing", parserClaimedAt: new Date() },
        });
        if (claimed.count !== 1) return;
      }
      const outcome = await ingest(input);
      if (input.attachmentId) {
        const parserState =
          outcome.status === "indexed"
            ? outcome.state
            : outcome.status === "reused"
              ? "ready"
              : outcome.status === "unavailable"
                ? "queued"
                : outcome.status;
        await prisma.attachment
          .updateMany({ where: { id: input.attachmentId, userId: input.userId }, data: { parserState, parserClaimedAt: null } })
          .catch((error) => {
            console.error("[knowledge] could not persist attachment parser state", {
              attachmentId: input.attachmentId,
              message: error instanceof Error ? error.message : String(error),
            });
          });

        // `reused` counts: identical bytes uploaded a second time index to the
        // document created for the first, and the new attachment row is just
        // as entitled to its own text.
        const documentId =
          outcome.status === "indexed" || outcome.status === "reused" ? outcome.documentId : null;
        if (documentId && parserState !== "failed") {
          await persistExtractedText({
            userId: input.userId,
            attachmentId: input.attachmentId,
            documentId,
          }).catch((error) => {
            // A file that indexed but whose text could not be copied back is
            // still findable by retrieval; this is a degradation, not a
            // failure, and it must not undo the parser state written above.
            console.error("[knowledge] could not persist extracted document text", {
              attachmentId: input.attachmentId,
              message: error instanceof Error ? error.message : String(error),
            });
          });
        }
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

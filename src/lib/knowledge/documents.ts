import "server-only";
import { prisma } from "@/lib/prisma";
import { RETRIEVABLE_STATES } from "@/lib/knowledge/lexical-query";
import {
  assembleDocumentText,
  documentOutline,
  type AssembledDocument,
  type DocumentBlock,
} from "@/lib/knowledge/document-text";

/**
 * Reading indexed documents back out of the database, whole or in parts.
 *
 * The Prisma half of `document-text.ts`. Everything here is owner-scoped:
 * KnowledgeDocument and KnowledgeBlock are both in `OWNER_COLUMN`
 * (`src/lib/db.ts`), so the guarded client already refuses a query that omits
 * `userId` — but every `where` below states it anyway, because a reader of
 * this file should not have to know about the extension to know the query is
 * safe.
 */

/** How many blocks one read may pull. A 300-page report is tens of thousands. */
const MAX_BLOCKS = 6_000;

export interface DocumentSummary {
  documentId: string;
  attachmentId: string | null;
  fileName: string;
  mimeType: string;
  pageCount: number | null;
  state: string;
  blockCount: number;
}

/** The live, non-superseded document for an attachment, if one was indexed. */
export async function documentForAttachment(
  userId: string,
  attachmentId: string,
): Promise<DocumentSummary | null> {
  const document = await prisma.knowledgeDocument.findFirst({
    where: {
      userId,
      attachmentId,
      deletedAt: null,
      supersededById: null,
      state: { in: RETRIEVABLE_STATES },
    },
    orderBy: { version: "desc" },
    select: { id: true, attachmentId: true, fileName: true, mimeType: true, pageCount: true, state: true },
  });
  if (!document) return null;
  const blockCount = await prisma.knowledgeBlock.count({
    where: { userId, documentId: document.id, deletedAt: null },
  });
  return {
    documentId: document.id,
    attachmentId: document.attachmentId,
    fileName: document.fileName,
    mimeType: document.mimeType,
    pageCount: document.pageCount,
    state: document.state,
    blockCount,
  };
}

/** Every indexed document behind a set of attachments, in upload order. */
export async function documentsForAttachments(
  userId: string,
  attachmentIds: readonly string[],
): Promise<DocumentSummary[]> {
  const ids = [...new Set(attachmentIds)].slice(0, 50);
  if (ids.length === 0) return [];
  const documents = await prisma.knowledgeDocument.findMany({
    where: {
      userId,
      attachmentId: { in: ids },
      deletedAt: null,
      supersededById: null,
      state: { in: RETRIEVABLE_STATES },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, attachmentId: true, fileName: true, mimeType: true, pageCount: true, state: true },
    take: 50,
  });
  if (documents.length === 0) return [];

  const counts = await prisma.knowledgeBlock.groupBy({
    by: ["documentId"],
    where: { userId, documentId: { in: documents.map((d) => d.id) }, deletedAt: null },
    _count: { _all: true },
  });
  const countBy = new Map(counts.map((row) => [row.documentId, row._count._all]));

  return documents.map((document) => ({
    documentId: document.id,
    attachmentId: document.attachmentId,
    fileName: document.fileName,
    mimeType: document.mimeType,
    pageCount: document.pageCount,
    state: document.state,
    blockCount: countBy.get(document.id) ?? 0,
  }));
}

export interface BlockWindow {
  /** 1-based page (or slide) to start at. */
  fromPage?: number | null;
  toPage?: number | null;
  /** Reading-order offset, for a document with no pages to anchor to. */
  offset?: number;
  limit?: number;
}

/** Blocks of one document in reading order, optionally windowed by page. */
export async function documentBlocks(
  userId: string,
  documentId: string,
  window: BlockWindow = {},
): Promise<DocumentBlock[]> {
  const limit = Math.min(MAX_BLOCKS, Math.max(1, window.limit ?? MAX_BLOCKS));
  const pageFilter =
    window.fromPage || window.toPage
      ? {
          page: {
            ...(window.fromPage ? { gte: window.fromPage } : {}),
            ...(window.toPage ? { lte: window.toPage } : {}),
          },
        }
      : {};

  const rows = await prisma.knowledgeBlock.findMany({
    where: { userId, documentId, deletedAt: null, ...pageFilter },
    orderBy: { ordinal: "asc" },
    skip: Math.max(0, window.offset ?? 0),
    take: limit,
    select: {
      ordinal: true,
      type: true,
      text: true,
      page: true,
      slide: true,
      sheet: true,
      cellRange: true,
      lineStart: true,
    },
  });
  return rows;
}

/**
 * One document as text, bounded.
 *
 * The workhorse behind both the extracted text stored on an attachment and the
 * `read_document` tool. `null` when nothing was indexed — never an empty
 * string, because "" and "this document has no text" are different facts and
 * only one of them should reach a model.
 */
export async function readDocumentText(
  userId: string,
  documentId: string,
  options: { maxChars?: number; window?: BlockWindow } = {},
): Promise<AssembledDocument | null> {
  const blocks = await documentBlocks(userId, documentId, options.window);
  if (blocks.length === 0) return null;
  return assembleDocumentText(blocks, { maxChars: options.maxChars });
}

/** The document's headings, for the case where it is too large to send whole. */
export async function readDocumentOutline(
  userId: string,
  documentId: string,
  limit = 60,
): Promise<string[]> {
  const rows = await prisma.knowledgeBlock.findMany({
    where: {
      userId,
      documentId,
      deletedAt: null,
      type: { in: ["heading", "slide_title"] },
    },
    orderBy: { ordinal: "asc" },
    take: limit,
    select: {
      ordinal: true,
      type: true,
      text: true,
      page: true,
      slide: true,
      sheet: true,
      cellRange: true,
      lineStart: true,
    },
  });
  return documentOutline(rows, { limit });
}

export interface DocumentMatch {
  text: string;
  ordinal: number;
  page: number | null;
  slide: number | null;
  sheet: string | null;
}

/**
 * Literal search inside one document.
 *
 * `contains` and not the full-text index on purpose. The lexical index is
 * stemmed and stop-worded, which is right for "find me the passage that is
 * about this" and wrong for the question this answers: "where does the string
 * `NDA-4417` appear". A model looking for an identifier, a figure number or a
 * column header wants the characters it typed, and a stemmer will not find
 * them. Retrieval (`retrieve.ts`) is still there for the semantic case.
 */
export async function searchDocument(
  userId: string,
  documentId: string,
  query: string,
  limit = 20,
): Promise<DocumentMatch[]> {
  const needle = query.trim();
  if (!needle) return [];
  const rows = await prisma.knowledgeBlock.findMany({
    where: {
      userId,
      documentId,
      deletedAt: null,
      text: { contains: needle, mode: "insensitive" },
    },
    orderBy: { ordinal: "asc" },
    take: Math.min(100, Math.max(1, limit)),
    select: { text: true, ordinal: true, page: true, slide: true, sheet: true },
  });
  return rows;
}

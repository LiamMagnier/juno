import "server-only";
import { prisma } from "@/lib/prisma";
import { getObjectBytes } from "@/lib/storage";
import { extractDocument } from "@/lib/knowledge/extract";
import { fileExtension } from "@/lib/documents/viewer-kind";
import { MAX_BLOCKS, readSheets, toReaderBlocks } from "@/lib/documents/reader-blocks";
import type { ReaderDocument } from "@/lib/documents/reader-types";

/**
 * An office document, laid out for READING rather than for retrieval.
 *
 * WHY NOT RENDER THE FILE. A browser draws a PDF page and an image; it has no
 * idea what a .docx is, and faithful Office rendering is a layout engine (and,
 * in practice, a LibreOffice install on the server). What Juno does have is
 * the structure the extractors already recovered — headings, paragraphs, list
 * items, tables, slide titles, speaker notes, sheets — in reading order. That
 * is exactly what a reading view needs, and it is the same text the model is
 * answering from, so what the person selects to ask about is what the model
 * can find.
 *
 * TWO SOURCES, IN ORDER. The index first: the blocks are already in Postgres
 * and reading them is one query. Then the file itself, through the same
 * `extractDocument` ladder ingest uses — for a document the indexer has not
 * reached yet or got wrong, which is the case `read-on-demand.ts` exists for
 * and whose reasoning applies here unchanged.
 *
 * SPREADSHEETS ARE THE EXCEPTION. The extractor writes a row as
 * "Header: value | Header: value" with empty cells dropped — right for a
 * retrieved row read out of context, wrong for a grid, where the column a
 * value sits in IS its meaning. So a workbook is read as cells, bounded.
 */

/** Bytes pulled from storage to read a file the index has not reached. */
const MAX_BYTES = 48 * 1024 * 1024;

async function indexedBlocks(userId: string, attachmentId: string) {
  const document = await prisma.knowledgeDocument.findFirst({
    where: { userId, attachmentId, deletedAt: null, supersededById: null },
    orderBy: { version: "desc" },
    select: { id: true, pageCount: true, error: true },
  });
  if (!document) return null;
  const rows = await prisma.knowledgeBlock.findMany({
    where: { userId, documentId: document.id, deletedAt: null },
    orderBy: { ordinal: "asc" },
    select: { type: true, text: true, page: true, slide: true, sheet: true, cellRange: true, heading: true },
    take: MAX_BLOCKS + 1,
  });
  if (!rows.length) return null;
  return { rows, pageCount: document.pageCount, note: document.error ?? undefined };
}

export async function readDocumentForViewer(
  userId: string,
  attachment: { id: string; storageKey: string; fileName: string; mimeType: string; size: number },
): Promise<ReaderDocument> {
  const ext = fileExtension(attachment.fileName);
  const isWorkbook = ext === "xlsx" || ext === "xlsm";

  if (!isWorkbook) {
    const indexed = await indexedBlocks(userId, attachment.id).catch(() => null);
    if (indexed) {
      const { blocks, truncated } = toReaderBlocks(indexed.rows);
      return {
        status: "ready",
        source: "index",
        blocks,
        pageCount: indexed.pageCount ?? null,
        truncated: truncated || indexed.rows.length > MAX_BLOCKS,
        ...(indexed.note ? { note: indexed.note } : {}),
      };
    }
  }

  if (attachment.size > MAX_BYTES) {
    return {
      status: "empty",
      source: "file",
      blocks: [],
      pageCount: null,
      truncated: false,
      note: "This file is too large to open here. Download it to read it in full.",
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = (await getObjectBytes(attachment.storageKey)).bytes;
  } catch {
    return { status: "empty", source: "file", blocks: [], pageCount: null, truncated: false, note: "The file could not be loaded." };
  }

  if (isWorkbook) {
    const read = await readSheets(bytes);
    if (read && read.sheets.some((sheet) => sheet.rows.length > 0)) {
      return {
        status: "ready",
        source: "file",
        blocks: [],
        sheets: read.sheets,
        pageCount: null,
        truncated: read.truncated,
      };
    }
  }

  let result;
  try {
    // `.slice()`: the extractors may transfer the buffer they are handed (see
    // read-on-demand.ts), and this request is the only holder of these bytes.
    result = await extractDocument({ bytes: bytes.slice(), fileName: attachment.fileName, mimeType: attachment.mimeType });
  } catch {
    result = null;
  }
  if (!result || !result.blocks.length) {
    return {
      status: "empty",
      source: "file",
      blocks: [],
      pageCount: result?.pageCount ?? null,
      truncated: false,
      note: result?.reason ?? "Juno could not find any text in this file.",
    };
  }
  const { blocks, truncated } = toReaderBlocks(result.blocks);
  return {
    status: result.status === "ok" ? "ready" : "partial",
    source: "file",
    blocks,
    pageCount: result.pageCount ?? null,
    truncated,
    ...(result.reason ? { note: result.reason } : {}),
  };
}

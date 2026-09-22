import "server-only";
import { getObjectBytes } from "@/lib/storage";
import { extractDocument } from "@/lib/knowledge/extract";
import { assembleDocumentText, type AssembledDocument, type DocumentBlock } from "@/lib/knowledge/document-text";

/**
 * Reading the FILE, when the index has nothing to say about it.
 *
 * WHY THE INDEX CANNOT BE THE ONLY ANSWER. Ingest runs once, in the background,
 * minutes before anybody asks a question, and it has to decide there and then
 * what a file contains. When it gets that wrong — a parser that called a
 * permissions-only PDF "password-protected", a page tree it could not walk, a
 * format nobody had added to the allowlist yet — the file is not merely
 * un-indexed. It is unreachable: `read_document` reads `KnowledgeBlock` rows,
 * so a tool built to rescue the model from a bad extraction inherited the bad
 * extraction instead, and answered "no text" about a document sitting intact
 * in storage.
 *
 * So the reader goes to the bytes. The index stays what it is good at —
 * retrieval across a corpus, with locators, already paid for — and this is the
 * floor underneath it: whatever the indexer concluded, the model can still ask
 * for the file and get what is actually in it.
 *
 * It is deliberately NOT a second extractor. It runs the same
 * `extractDocument` ladder the indexer runs, on freshly fetched bytes, and
 * assembles the result the same way. What changes is only WHEN it runs — on
 * demand, for one file the model has asked about, rather than once for
 * everything at upload time.
 */

/** One read's ceiling on bytes pulled from storage. Matches the ingest bound. */
const MAX_BYTES = 64 * 1024 * 1024;

export interface OnDemandRead extends AssembledDocument {
  /** What the extractor made of it, for an honest note to the model. */
  status: string;
  /** The extractor's own sentence, when it had one. */
  reason?: string;
  pageCount: number | null;
}

/**
 * Read an attachment's text straight from its bytes.
 *
 * `null` means the file genuinely yielded nothing — not that a lookup missed.
 * Never throws: a storage blip or a corrupt upload must degrade the tool's
 * answer, not end the turn the model is in the middle of.
 */
export async function readAttachmentOnDemand(
  attachment: { storageKey: string; fileName: string; mimeType: string; size?: number },
  options: { maxChars?: number } = {},
): Promise<OnDemandRead | null> {
  if (attachment.size != null && attachment.size > MAX_BYTES) return null;

  let bytes: Uint8Array;
  try {
    bytes = (await getObjectBytes(attachment.storageKey)).bytes;
  } catch {
    return null;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return null;

  let result;
  try {
    /*
     * `.slice()`, because pdf.js TRANSFERS the buffer it is handed — a real
     * file measures 16978 bytes going in and 0 coming out. Passing the only
     * copy would leave every later reader in this request holding an empty
     * array, which is precisely the bug that kept OCR from ever running.
     */
    result = await extractDocument({
      bytes: bytes.slice(),
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
    });
  } catch {
    return null;
  }
  if (!result) return null;

  const blocks: DocumentBlock[] = result.blocks.map((block, ordinal) => ({
    ordinal,
    type: block.type,
    text: block.text,
    page: block.page ?? null,
    slide: block.slide ?? null,
    sheet: block.sheet ?? null,
    cellRange: block.cellRange ?? null,
    lineStart: block.lineStart ?? null,
  }));
  const assembled = assembleDocumentText(blocks, { maxChars: options.maxChars });
  if (!assembled.text) return null;

  return {
    ...assembled,
    status: result.status,
    ...(result.reason ? { reason: result.reason } : {}),
    pageCount: result.pageCount ?? null,
  };
}

/** Formats whose pages can be handed to a vision model when there is no text. */
export function canReadAsPages(mimeType: string): boolean {
  return mimeType.toLowerCase() === "application/pdf";
}

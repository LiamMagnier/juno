/**
 * Which extractor a file gets, and the one call that runs it.
 *
 * The extension leads and the MIME type follows, which looks backwards until you
 * read `planAttachmentUpload`: every non-image upload is deliberately stored as
 * `application/octet-stream` so the storage host can never serve it back inline.
 * By the time a file reaches here its declared type has usually been erased on
 * purpose, and the name is the only surviving evidence of what it is.
 */

import { DOCX_PARSER_VERSION, extractDocx } from "./docx";
import { PDF_PARSER_VERSION, extractPdf } from "./pdf";
import { PPTX_PARSER_VERSION, extractPptx } from "./pptx";
import { TEXT_PARSER_VERSION, extractTextDocument, textFlavor } from "./text";
import { XLSX_PARSER_VERSION, extractXlsx } from "./xlsx";
import { ocrPdf, OCR_VERSION } from "../ocr";
import { extractPdfWithEngine, PDF_ENGINE, PDF_ENGINE_VERSION } from "./pdf-engine";
import type { ExtractionResult } from "./types";

export type ExtractorId = "pdf" | "docx" | "pptx" | "xlsx" | "text";

/**
 * The version each extractor is currently on, in one place.
 *
 * Ingest records this on the document, and re-indexes any document whose stored
 * version is behind. Bumping the constant in an extractor module is therefore
 * the whole of "make every affected document reindex" — which is the point of
 * `parserVersion` existing in the schema at all.
 */
export const PARSER_VERSIONS: Record<ExtractorId, string> = {
  pdf: PDF_PARSER_VERSION,
  docx: DOCX_PARSER_VERSION,
  pptx: PPTX_PARSER_VERSION,
  xlsx: XLSX_PARSER_VERSION,
  text: TEXT_PARSER_VERSION,
};

const BY_EXTENSION: Record<string, ExtractorId> = {
  pdf: "pdf",
  docx: "docx",
  docm: "docx",
  pptx: "pptx",
  pptm: "pptx",
  xlsx: "xlsx",
  xlsm: "xlsx",
};

const BY_MIME: Record<string, ExtractorId> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

/**
 * The extractor for a file, or null when nothing here can read it.
 *
 * Null is a real answer, not a failure: a PNG, a zip of holiday photos and a
 * `.mov` all land here, and none of them should produce a KnowledgeDocument at
 * all. Creating a `failed` document for every image a user uploads would turn
 * the knowledge library into a list of things that went wrong.
 */
export function selectExtractor(fileName: string, mimeType: string): ExtractorId | null {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  const byExt = BY_EXTENSION[ext];
  if (byExt) return byExt;

  const mime = mimeType.toLowerCase().split(";")[0].trim();
  const byMime = BY_MIME[mime];
  if (byMime) return byMime;

  // Legacy binary Office formats are ZIP-less and unreadable here. They are
  // still claimed, so the user gets "save it as .docx" rather than silence.
  if (ext === "doc" || ext === "ppt" || ext === "xls") return null;

  if (mime.startsWith("image/") || mime.startsWith("video/") || mime.startsWith("audio/")) return null;

  // Anything the text extractor recognizes by name, plus genuinely text MIME
  // types. `textFlavor` returns "plain" for everything it does not know, so the
  // extension check has to come first or every binary would be claimed.
  const flavor = textFlavor(fileName, mimeType);
  if (flavor !== "plain") return "text";
  if (mime.startsWith("text/") || mime === "application/json" || mime === "application/xml") return "text";
  if (mime === "application/octet-stream" && /\.(txt|log|csv|tsv|text)$/i.test(fileName)) return "text";
  return null;
}

export interface ExtractInput {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
}

/**
 * Run the right extractor. Never throws — an extractor that manages to throw
 * anyway is converted into a `failed` result here, because ingest treats a
 * thrown error and a failed result identically and there is no reason for the
 * caller to handle two shapes of the same thing.
 */
/** The pages an extraction actually produced text for. */
function readablePages(result: { blocks: readonly { page?: number }[] }): Set<number> {
  const pages = new Set<number>();
  for (const block of result.blocks) {
    if (typeof block.page === "number") pages.add(block.page);
  }
  return pages;
}

export async function extractDocument(input: ExtractInput): Promise<ExtractionResult | null> {
  const extractor = selectExtractor(input.fileName, input.mimeType);
  if (!extractor) return null;

  try {
    switch (extractor) {
      case "pdf":
        {
          const parsed = extractPdf(input);
          // OCR is a fallback only. Preserve embedded text at confidence 1 and
          // add OCR blocks only for pages the native parser could not read.
          if (parsed.status !== "degraded" || parsed.pageCount === undefined) return parsed;

          /*
           * ── THE PDF.JS RUNG, BETWEEN THE NATIVE PARSER AND OCR ───────────
           *
           * The native parser degrades on a whole class of ordinary file:
           * subset CID fonts with Identity-H encoding and no `/ToUnicode`
           * map, which is what LaTeX and InDesign emit, which is to say most
           * technical reports. Those used to fall straight through to OCR —
           * and OCR needs `JUNO_OCR_ENDPOINT` or tesseract on the host, so on
           * a deployment with neither, a perfectly readable PDF indexed as
           * NOTHING and the first anyone heard of it was the model saying it
           * had received no text.
           *
           * pdf.js decodes those fonts, it is already in this repo (`unpdf`,
           * reading PDFs for the research engine), and it costs no binaries
           * and no service. So it goes first. OCR keeps its place as the last
           * resort, for pages that have no text layer at all — a scan — which
           * is the only thing it was ever the right answer for.
           */
          const engine = await extractPdfWithEngine({
            bytes: input.bytes,
            fileName: input.fileName,
            skipPages: readablePages(parsed),
            maxPages: parsed.pageCount,
          });
          const enginePages = engine.status === "ok" ? engine.pages : new Set<number>();
          const withEngine =
            engine.status === "ok"
              ? {
                  ...parsed,
                  parserVersion: `${PDF_PARSER_VERSION}+${PDF_ENGINE}${PDF_ENGINE_VERSION}`,
                  blocks: [...parsed.blocks, ...engine.blocks],
                }
              : parsed;

          // Every page accounted for: the document is whole, however it was
          // read, and calling it degraded would send a reader looking for a
          // problem that no longer exists.
          const readAfterEngine = readablePages(withEngine);
          if (readAfterEngine.size >= (parsed.pageCount ?? 0)) {
            return {
              ...withEngine,
              status: "ok" as const,
              reason: undefined,
            };
          }

          const ocr = await ocrPdf({
            bytes: input.bytes,
            fileName: input.fileName,
            pageCount: parsed.pageCount,
          });
          const recovered = enginePages.size
            ? ` The PDF reader recovered ${enginePages.size} page${enginePages.size === 1 ? "" : "s"} the native parser could not decode.`
            : "";
          if (ocr.status !== "ok") {
            return {
              ...withEngine,
              parserVersion: `${PDF_PARSER_VERSION}+${PDF_ENGINE}${PDF_ENGINE_VERSION}+ocr${OCR_VERSION}`,
              reason: `${parsed.reason ?? "This PDF is only partially readable."}${recovered} OCR fallback was unavailable: ${ocr.reason}`,
            };
          }
          const ocrBlocks = ocr.blocks.filter(
            (block) => typeof block.page === "number" && !readAfterEngine.has(block.page)
          );
          const ocrPages = new Set(ocrBlocks.map((block) => block.page).filter((page): page is number => typeof page === "number"));
          return {
            ...withEngine,
            parserVersion: `${PDF_PARSER_VERSION}+${PDF_ENGINE}${PDF_ENGINE_VERSION}+ocr${OCR_VERSION}`,
            status: "degraded",
            blocks: [...withEngine.blocks, ...ocrBlocks],
            reason: `${parsed.reason ?? "Some PDF pages required OCR."}${recovered} OCR recovered ${ocrPages.size} page${ocrPages.size === 1 ? "" : "s"} with measured confidence; verify OCR text against the original.`,
          };
        }
      case "docx":
        return await extractDocx(input);
      case "pptx":
        return await extractPptx(input);
      case "xlsx":
        return await extractXlsx(input);
      case "text":
        return extractTextDocument(input);
    }
  } catch (error) {
    return {
      parser: extractor,
      parserVersion: PARSER_VERSIONS[extractor],
      status: "failed",
      blocks: [],
      reason: `This file could not be read: ${error instanceof Error ? error.message : "the extractor failed"}.`,
    };
  }
}

export { extractDocx, extractPdf, extractPptx, extractTextDocument, extractXlsx };
export * from "./types";

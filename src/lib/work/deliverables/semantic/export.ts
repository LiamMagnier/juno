/**
 * Semantic artifact -> Office file, and Office file -> semantic artifact.
 * Server-only by the import graph (exceljs, docx, pptxgenjs, jszip).
 */

import {
  SEMANTIC_EXTENSION,
  normalizeSemantic,
  serializeSemantic,
  type SemanticArtifactType,
} from "@/lib/work/deliverables/semantic";
import { SemanticError } from "@/lib/work/deliverables/semantic/shared";
import type { WorkbookModel } from "@/lib/work/deliverables/semantic/workbook/model";
import type { DocumentModel } from "@/lib/work/deliverables/semantic/document/model";
import type { DeckModel } from "@/lib/work/deliverables/semantic/deck/model";
import { exportWorkbookXlsx, readWorkbookXlsx } from "@/lib/work/deliverables/semantic/workbook/xlsx";
import { exportDocumentDocx, readDocumentDocx } from "@/lib/work/deliverables/semantic/document/docx-export";
import { exportDeckPptx } from "@/lib/work/deliverables/semantic/deck/pptx-export";

export const SEMANTIC_MIME: Record<SemanticArtifactType, string> = {
  SPREADSHEET: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  DOCUMENT: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  PRESENTATION: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export async function exportSemanticArtifact(
  type: SemanticArtifactType,
  content: string
): Promise<{ bytes: Buffer; mime: string; extension: string }> {
  const model = normalizeSemantic(type, content);
  let bytes: Buffer;
  switch (type) {
    case "SPREADSHEET":
      bytes = await exportWorkbookXlsx(model as WorkbookModel);
      break;
    case "DOCUMENT":
      bytes = await exportDocumentDocx(model as DocumentModel);
      break;
    case "PRESENTATION":
      bytes = await exportDeckPptx(model as DeckModel);
      break;
  }
  return { bytes, mime: SEMANTIC_MIME[type], extension: SEMANTIC_EXTENSION[type] };
}

/**
 * An uploaded .xlsx or .docx -> a stored body. A .pptx is not imported: the
 * readback recovers text and chart data, not the full deck model, and an
 * import that silently drops layout would be a lossy copy presented as the file.
 */
export async function importSemanticFile(
  extension: string,
  bytes: Buffer,
  title?: string
): Promise<{ type: SemanticArtifactType; content: string; notes: string[] }> {
  switch (extension.toLowerCase()) {
    case "xlsx": {
      const { model, report } = await readWorkbookXlsx(bytes, title ? { title } : {});
      const notes: string[] = [];
      if (report.opaqueFormulas.length) {
        notes.push(`${report.opaqueFormulas.length} formula${report.opaqueFormulas.length === 1 ? "" : "s"} kept with their last value (functions this workbook does not compute)`);
      }
      if (report.droppedFormats) notes.push(`${report.droppedFormats} number format${report.droppedFormats === 1 ? "" : "s"} not carried over`);
      return { type: "SPREADSHEET", content: serializeSemantic("SPREADSHEET", model), notes };
    }
    case "docx": {
      const model = await readDocumentDocx(bytes);
      if (title) model.title = title;
      return { type: "DOCUMENT", content: serializeSemantic("DOCUMENT", model), notes: [] };
    }
    default:
      throw new SemanticError("unreadable", `A .${extension} file cannot be opened as an editable artifact`);
  }
}

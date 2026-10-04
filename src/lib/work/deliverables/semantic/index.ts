/**
 * One door to the three semantic models, keyed by artifact type.
 *
 * The chat route, the artifact verifier, the canvas and the ops API all ask the
 * same four questions of a SPREADSHEET, DOCUMENT or PRESENTATION body — is it
 * valid, apply these operations, outline it for the model, summarise it for a
 * card — and this module answers them without importing any Office writer, so
 * the browser can use it too. Export lives in `./export.ts` (server).
 */

import { z } from "zod";
import { SemanticError, type SemanticKind } from "@/lib/work/deliverables/semantic/shared";
import { WorkbookEngine } from "@/lib/work/deliverables/semantic/workbook/engine";
import { normalizeWorkbook, serializeWorkbook, type WorkbookModel } from "@/lib/work/deliverables/semantic/workbook/model";
import { applyWorkbookOps, workbookOpsSchema } from "@/lib/work/deliverables/semantic/workbook/ops";
import { outlineWorkbook } from "@/lib/work/deliverables/semantic/workbook/view";
import { normalizeDocument, outlineDocument, serializeDocument, type DocumentModel } from "@/lib/work/deliverables/semantic/document/model";
import { applyDocumentOps, documentOpsSchema } from "@/lib/work/deliverables/semantic/document/ops";
import { normalizeDeck, outlineDeck, serializeDeck, type DeckModel } from "@/lib/work/deliverables/semantic/deck/model";
import { applyDeckOps, deckOpsSchema } from "@/lib/work/deliverables/semantic/deck/ops";
import { validateDeckFit, type FitIssue } from "@/lib/work/deliverables/semantic/deck/fit";

export { SemanticError } from "@/lib/work/deliverables/semantic/shared";

export const SEMANTIC_ARTIFACT_TYPES = ["SPREADSHEET", "DOCUMENT", "PRESENTATION"] as const;
export type SemanticArtifactType = (typeof SEMANTIC_ARTIFACT_TYPES)[number];

export function isSemanticArtifactType(type: string | null | undefined): type is SemanticArtifactType {
  return (SEMANTIC_ARTIFACT_TYPES as readonly string[]).includes(String(type ?? "").toUpperCase());
}

export const SEMANTIC_KIND: Record<SemanticArtifactType, SemanticKind> = {
  SPREADSHEET: "spreadsheet",
  DOCUMENT: "document",
  PRESENTATION: "presentation",
};

export const SEMANTIC_EXTENSION: Record<SemanticArtifactType, "xlsx" | "docx" | "pptx"> = {
  SPREADSHEET: "xlsx",
  DOCUMENT: "docx",
  PRESENTATION: "pptx",
};

export type SemanticModel = WorkbookModel | DocumentModel | DeckModel;

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw new SemanticError("invalid_model", "The body is not JSON");
  }
}

/** Validate a body (authoring form or stored form) and return its model. */
export function normalizeSemantic(type: SemanticArtifactType, input: unknown): SemanticModel {
  const value = typeof input === "string" ? parseJson(input) : input;
  switch (type) {
    case "SPREADSHEET":
      return normalizeWorkbook(value);
    case "DOCUMENT":
      return normalizeDocument(value);
    case "PRESENTATION":
      return normalizeDeck(value);
  }
}

/** The stored body of a model. */
export function serializeSemantic(type: SemanticArtifactType, model: SemanticModel): string {
  switch (type) {
    case "SPREADSHEET":
      return serializeWorkbook(model as WorkbookModel);
    case "DOCUMENT":
      return serializeDocument(model as DocumentModel);
    case "PRESENTATION":
      return serializeDeck(model as DeckModel);
  }
}

/** Authoring form -> stored body. Throws SemanticError. */
export function canonicalSemanticBody(type: SemanticArtifactType, content: string): string {
  return serializeSemantic(type, normalizeSemantic(type, content));
}

export interface SemanticEditResult {
  content: string;
  model: SemanticModel;
  changes: string[];
  /** Spreadsheet only: what recalculated and which charts redrew. */
  recalculated?: string[];
  chartsChanged?: string[];
  /** Presentation only: fit problems the edited deck has. */
  fit?: FitIssue[];
}

const opsSchemaFor = {
  SPREADSHEET: workbookOpsSchema,
  DOCUMENT: documentOpsSchema,
  PRESENTATION: deckOpsSchema,
} as const;

/**
 * Validate operations from untrusted JSON and apply them to a stored body.
 * Returns the new stored body; throws SemanticError (with `opIndex`) and
 * applies nothing on any failure.
 */
export function applySemanticOps(
  type: SemanticArtifactType,
  content: string,
  rawOps: unknown,
  options: { now?: Date; author?: string } = {}
): SemanticEditResult {
  const parsed = opsSchemaFor[type].safeParse(rawOps);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const index = typeof issue?.path[0] === "number" ? issue.path[0] + 1 : undefined;
    throw new SemanticError(
      "invalid_op",
      `${index ? `Operation ${index}: ` : ""}${issue ? `${issue.path.slice(1).map(String).join(".") || "op"}: ${issue.message}` : "invalid operations"}`,
      index
    );
  }
  const model = normalizeSemantic(type, content);
  switch (type) {
    case "SPREADSHEET": {
      const result = applyWorkbookOps(model as WorkbookModel, parsed.data as z.infer<typeof workbookOpsSchema>);
      return {
        content: serializeWorkbook(result.model),
        model: result.model,
        changes: result.changes,
        recalculated: result.recalculated,
        chartsChanged: result.chartsChanged,
      };
    }
    case "DOCUMENT": {
      const result = applyDocumentOps(model as DocumentModel, parsed.data as z.infer<typeof documentOpsSchema>, options);
      return { content: serializeDocument(result.model), model: result.model, changes: result.changes };
    }
    case "PRESENTATION": {
      const result = applyDeckOps(model as DeckModel, parsed.data as z.infer<typeof deckOpsSchema>);
      return { content: serializeDeck(result.model), model: result.model, changes: result.changes, fit: validateDeckFit(result.model) };
    }
  }
}

/** The addressable outline the chat model reads before it edits. */
export function outlineSemantic(type: SemanticArtifactType, content: string, maxChars = 12_000): string {
  const model = normalizeSemantic(type, content);
  switch (type) {
    case "SPREADSHEET":
      return outlineWorkbook(model as WorkbookModel, new WorkbookEngine(model as WorkbookModel), maxChars);
    case "DOCUMENT":
      return outlineDocument(model as DocumentModel, maxChars);
    case "PRESENTATION":
      return outlineDeck(model as DeckModel, maxChars);
  }
}

/** A short line for cards and the Library: "3 sheets · 2 charts", "14 blocks · 2 comments", "8 slides". */
export function describeSemantic(type: SemanticArtifactType, content: string): string {
  try {
    const model = normalizeSemantic(type, content);
    switch (type) {
      case "SPREADSHEET": {
        const wb = model as WorkbookModel;
        const charts = wb.sheets.reduce((n, s) => n + s.charts.length, 0);
        const formulas = wb.sheets.reduce((n, s) => n + Object.values(s.cells).filter((c) => c.f !== undefined).length, 0);
        return [
          `${wb.sheets.length} sheet${wb.sheets.length === 1 ? "" : "s"}`,
          formulas ? `${formulas} formula${formulas === 1 ? "" : "s"}` : null,
          charts ? `${charts} chart${charts === 1 ? "" : "s"}` : null,
        ]
          .filter(Boolean)
          .join(" · ");
      }
      case "DOCUMENT": {
        const doc = model as DocumentModel;
        const open = doc.comments.filter((c) => !c.resolved).length;
        const pending = doc.revisions.filter((r) => r.status === "pending").length;
        return [
          `${doc.blocks.length} block${doc.blocks.length === 1 ? "" : "s"}`,
          open ? `${open} comment${open === 1 ? "" : "s"}` : null,
          pending ? `${pending} suggestion${pending === 1 ? "" : "s"}` : null,
        ]
          .filter(Boolean)
          .join(" · ");
      }
      case "PRESENTATION": {
        const deck = model as DeckModel;
        return `${deck.slides.length} slide${deck.slides.length === 1 ? "" : "s"}`;
      }
    }
  } catch {
    return "";
  }
}

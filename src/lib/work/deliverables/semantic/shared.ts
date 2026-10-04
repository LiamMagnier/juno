/**
 * The contract every semantic deliverable model keeps (BRIEF §29).
 *
 * A semantic artifact is a document, workbook or deck stored as its own model
 * (JSON in an `ArtifactVersion` body), not as Markdown that a renderer guesses
 * a structure from. Three things follow, and each kind module implements them
 * the same way:
 *
 *   normalize   untrusted JSON (the model's authoring form, an import, a stored
 *               body) -> a validated model with every id assigned. Throws
 *               `SemanticError` and never repairs by guessing.
 *   applyOps    model + validated operations -> a NEW model plus one human line
 *               per change. Pure and all-or-nothing: an operation that fails
 *               leaves the input untouched, because the caller only stores the
 *               result when every operation succeeded.
 *   outline     model -> a bounded, addressable text the chat model reads when
 *               it is asked to edit the artifact, so its operations can name
 *               real cell addresses, block ids and slide ids.
 *
 * These files import no Office writer, so the canvas renders the same model in
 * the browser that the server exports. The writers (exceljs, docx, pptxgenjs)
 * live in the `*-export.ts` files beside each model and are server-only by the
 * import graph, the same rule `../index.ts` explains.
 */

export type SemanticKind = "spreadsheet" | "document" | "presentation";

export type SemanticErrorCode =
  /** The JSON does not match the model's schema. */
  | "invalid_model"
  /** An operation is malformed or contradicts the model (a missing id, a bad range). */
  | "invalid_op"
  /** An operation names a sheet, cell, block, slide or element that does not exist. */
  | "not_found"
  /** A formula that does not parse, uses an unknown function or references nothing. */
  | "invalid_formula"
  /** A formula edit that would make a cell depend on itself. */
  | "cycle"
  /** Past a size bound: cells, blocks, slides, characters. */
  | "too_large"
  /** An imported file this build cannot read. */
  | "unreadable";

export class SemanticError extends Error {
  constructor(
    readonly code: SemanticErrorCode,
    message: string,
    /** The 1-based index of the failing operation, when one did. */
    readonly opIndex?: number
  ) {
    super(message);
    this.name = "SemanticError";
  }
}

/** The result of applying a batch of operations. */
export interface SemanticOpResult<M> {
  model: M;
  /** One plain sentence per change, in order, for the version note and the transcript. */
  changes: string[];
}

/**
 * Ids the model never has to invent. Short, stable, readable in an outline,
 * and unique inside one model: `b7`, `s3`, `e12`.
 */
export function nextId(prefix: string, taken: Iterable<string>): string {
  let max = 0;
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  for (const id of taken) {
    const match = pattern.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}${max + 1}`;
}

/** A deep copy the operations can mutate without touching the caller's model. */
export function cloneModel<M>(model: M): M {
  return structuredClone(model);
}

/** Truncate a line for an outline, keeping it one line. */
export function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Only `data:` images (PNG, JPEG, GIF, WebP, SVG excluded) are embedded in an
 * export. An `https:` image is kept in the model and shown in the canvas, but
 * the exporter does not fetch it: a server-side fetch of a URL the model wrote
 * is a request forgery primitive, and a placeholder that names the picture is
 * the honest form.
 */
export const EMBEDDABLE_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/;

/** An image source the model may store: an embeddable data URI or a plain https URL. */
export function isAllowedImageSource(src: string): boolean {
  if (EMBEDDABLE_IMAGE.test(src)) return true;
  try {
    const url = new URL(src);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Decode an embeddable data URI to bytes and its extension, or null. */
export function decodeDataImage(src: string): { bytes: Buffer; extension: "png" | "jpeg" | "gif" | "webp" } | null {
  const match = EMBEDDABLE_IMAGE.exec(src);
  if (!match) return null;
  const subtype = match[1] === "jpg" ? "jpeg" : (match[1] as "png" | "jpeg" | "gif" | "webp");
  const base64 = src.slice(src.indexOf(",") + 1).replace(/\s+/g, "");
  return { bytes: Buffer.from(base64, "base64"), extension: subtype };
}

/** Format zod issues as one readable line for a SemanticError. */
export function describeIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .slice(0, 6)
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

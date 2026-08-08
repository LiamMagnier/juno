/**
 * Proving that an exported artifact actually opens, before it is streamed.
 *
 * `toDocx`/`toXlsx`/`toPptx` returning a Buffer is not evidence that the file
 * is a file. A docx builder that threw after packing the relationship parts
 * returns a non-empty zip with no `word/document.xml` in it; pptxgenjs writes a
 * structurally valid package with zero slides when a deck ends up empty. Both
 * look like success to the export route and both open to an error dialog on the
 * reader's machine — which is the worst place to discover it, because by then
 * they have forwarded it to somebody.
 *
 * The Work pipeline already answers this question properly, in
 * `src/lib/work/deliverables/validate.ts`: it re-opens the bytes with a reader
 * that had no part in writing them. The formats are the same three OOXML
 * packages, so the check is the same check, and a second implementation here
 * would be a second set of rules to keep in step with the first. This module is
 * the adapter between the two vocabularies and nothing else.
 *
 * Why it is a module of its own rather than a function in `office-export.ts`:
 * that file begins with `import "server-only"`, which throws outside a
 * React-server resolution and so cannot be reached from `tsx --test`. The
 * deliverables validator is deliberately free of `server-only` and Prisma for
 * exactly this reason (see its header), and putting the mapping anywhere that
 * drags the docx/exceljs/pptxgenjs writers in would throw that away. Only the
 * `OfficeFormat` *type* is imported, which erases at compile time.
 */

import type { OfficeFormat } from "@/lib/office-export";
import type { WorkArtifactKind } from "@/lib/work/domain";
import {
  validateDeliverable,
  type DeliverableValidation,
} from "@/lib/work/deliverables/validate";

/**
 * The Work artifact kind each export format is, so the right reader is used.
 *
 * A total `Record`, not a lookup with a fallback: adding a fourth export format
 * must fail to compile here rather than silently validate as a document, which
 * is the failure mode where a check exists and proves nothing.
 */
export const WORK_KIND_FOR_OFFICE_FORMAT: Record<OfficeFormat, WorkArtifactKind> = {
  docx: "document",
  xlsx: "spreadsheet",
  pptx: "presentation",
};

/**
 * Re-open an exported buffer and report what was found.
 *
 * Never throws, for the reason `validateDeliverable` never throws: a caller
 * that cannot tell "the file is broken" from "the checker is broken" has to
 * treat both as fatal anyway, and the returned verdict already says which
 * happened with the reason attached.
 */
export function verifyOfficeExport(
  format: OfficeFormat,
  bytes: Buffer,
  options: { now?: Date } = {}
): Promise<DeliverableValidation> {
  return validateDeliverable(WORK_KIND_FOR_OFFICE_FORMAT[format], bytes, options);
}

/**
 * What a user is told when the file did not survive the check.
 *
 * Deliberately not the validator's own problem strings. Those name OOXML parts
 * — "The package has no word/document.xml" — which is the right level of detail
 * for the log and the report, and no level of detail at all for somebody who
 * pressed Download. What they need is that nothing was served, that the file
 * they would otherwise be holding would not have opened, and that trying again
 * is worth doing because the conversion is not deterministic across edits.
 */
export function exportVerificationMessage(format: OfficeFormat): string {
  return (
    `Juno built the .${format} but it failed the check that it opens, so it was not ` +
    `downloaded — a file that will not open is worse than no file. Edit the artifact and ` +
    `try again, or export another format.`
  );
}

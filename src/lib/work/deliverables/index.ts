/**
 * Typed deliverables: one spec in, one file plus its content hash out.
 *
 * This is the envelope around the five generators. A caller hands it a spec
 * that has been validated against a schema — never free text a renderer has to
 * guess at — and gets back the exact bytes that will be stored, the SHA-256 of
 * those bytes, and a verdict from a reader that re-opened them. Nothing here
 * touches Prisma or object storage: the routes persist, this produces, and the
 * split is what lets `tests/work-deliverables.test.ts` generate and validate
 * every kind with no database anywhere near it.
 *
 * The order in `generateDeliverable` is the substance of the module and is not
 * arbitrary:
 *
 *   build -> cap -> hash -> validate
 *
 * The cap is checked on the finished bytes rather than estimated from the spec,
 * because compression makes any estimate wrong in both directions and the
 * number a user must be told is the real one. The hash is taken before
 * validation so the verdict is provably about the bytes that were hashed and
 * therefore about the bytes the download route will later re-hash. Validation
 * is last because it is the only step that can say the file opens, and a
 * verdict recorded against anything other than the stored bytes is a verdict
 * about a different file.
 *
 * No `import "server-only"` here, and the omission is deliberate rather than an
 * oversight. The convention elsewhere is that docx/exceljs/pptxgenjs sit behind
 * that marker so they cannot be pulled into a client bundle; what actually
 * enforces that is the import graph, and the only importers of this directory
 * are Node route handlers (`export const runtime = "nodejs"`) and the cloud
 * runner. Adding the marker would make the whole directory unimportable from
 * `tsx --test`, which runs without the `react-server` condition — and a test
 * that cannot open the files it generated proves nothing about whether they
 * open. `src/lib/work/digests.ts` and `serializers.ts` make the same trade for
 * the same reason.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ARTIFACT_EXTENSION,
  ARTIFACT_MIME,
  type WorkArtifactKind,
} from "@/lib/work/domain";
import { buildDocument, documentSpecSchema } from "@/lib/work/deliverables/document";
import { buildPresentation, presentationSpecSchema } from "@/lib/work/deliverables/presentation";
import { buildReport, reportSpecSchema } from "@/lib/work/deliverables/report";
import { buildSite, siteSpecSchema } from "@/lib/work/deliverables/site";
import { buildSpreadsheet, spreadsheetSpecSchema } from "@/lib/work/deliverables/spreadsheet";
import {
  MAX_PROVENANCE_ENTRIES,
  enforceByteCap,
  provenanceEntrySchema,
  validateDeliverable,
  type DeliverableErrorCode,
  type DeliverableValidation,
  type ProvenanceEntry,
} from "@/lib/work/deliverables/validate";

export {
  DeliverableError,
  assertSafeBundlePath,
  bundlePathProblem,
  byteCapProblem,
  formatBytes,
  isSafeBundlePath,
  validateDeliverable,
  DELIVERABLE_VALIDATOR,
  PROVENANCE_KINDS,
  provenanceEntrySchema,
  type DeliverableErrorCode,
  type DeliverableValidation,
  type ProvenanceEntry,
  type ProvenanceKind,
} from "@/lib/work/deliverables/validate";

export type { DocumentSpec } from "@/lib/work/deliverables/document";
export type { PresentationSpec } from "@/lib/work/deliverables/presentation";
export type { ReportSpec } from "@/lib/work/deliverables/report";
export type { SiteSpec } from "@/lib/work/deliverables/site";
export type { SpreadsheetSpec } from "@/lib/work/deliverables/spreadsheet";
export { bundleFiles, type BundleEntry } from "@/lib/work/deliverables/site";

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

/**
 * The kinds this build can generate.
 *
 * A subset of `WORK_ARTIFACT_KINDS` on purpose: `pdf`, `image`, `bundle` and
 * `archive` are kinds an artifact row may legitimately hold — a run can attach
 * a PDF it downloaded — but they are not kinds Juno composes from a spec, and
 * pretending otherwise would put a generator name in the vocabulary with no
 * generator behind it.
 */
export const GENERATED_DELIVERABLE_KINDS = [
  "document",
  "spreadsheet",
  "presentation",
  "report",
  "site",
] as const;

export type GeneratedDeliverableKind = (typeof GENERATED_DELIVERABLE_KINDS)[number];

export const deliverableSpecSchema = z.discriminatedUnion("kind", [
  documentSpecSchema,
  spreadsheetSpecSchema,
  presentationSpecSchema,
  reportSpecSchema,
  siteSpecSchema,
]);

export type DeliverableSpec = z.infer<typeof deliverableSpecSchema>;

/** Spec plus where its content came from. The pair a version is built from. */
export const deliverableRequestSchema = z.object({
  spec: deliverableSpecSchema,
  /**
   * Separate from the spec because it is a claim about the spec, not part of
   * it: the same table of figures is the same deliverable whether it was read
   * off three web pages or one connector, and the citation list is what a
   * reviewer checks against.
   */
  provenance: z.array(provenanceEntrySchema).max(MAX_PROVENANCE_ENTRIES).optional(),
});

export type DeliverableRequest = z.infer<typeof deliverableRequestSchema>;

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface GeneratedDeliverable {
  kind: GeneratedDeliverableKind;
  title: string;
  /** From `ARTIFACT_MIME`, which is the single source of truth for both. */
  mimeType: string;
  extension: string;
  bytes: Buffer;
  byteSize: number;
  /** SHA-256, lower-case hex, over exactly these bytes. */
  contentHash: string;
  provenance: ProvenanceEntry[];
  validation: DeliverableValidation;
  /**
   * A self-contained printable page, for the kinds that have one.
   *
   * Present only for `report`, whose stored bytes are markdown. It is not
   * persisted: `WorkArtifactVersion` stores one object key per version, so a
   * second representation of the same version has nowhere to live without a
   * schema change. A print surface renders this from the spec instead.
   */
  printableHtml?: string;
}

/** SHA-256 of exactly these bytes, in the form `WorkArtifactVersion.contentHash` holds. */
export function contentHashFor(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Builds a deliverable and proves it opens.
 *
 * Returns a `validation` verdict rather than throwing when the file fails to
 * re-open. That is the same distinction `WorkArtifact.validatedAt` draws: a
 * deliverable that was produced but could not be validated still exists, is
 * still worth storing, and is still worth showing to the user — as unvalidated.
 * Throwing would delete the evidence of the failure along with the file.
 *
 * It DOES throw for the three cases where there is nothing to store: a spec
 * that contradicts itself, an entry name that would escape a bundle, and a file
 * past its ceiling.
 */
export async function generateDeliverable(
  request: DeliverableRequest,
  options: { now?: Date } = {}
): Promise<GeneratedDeliverable> {
  const { spec } = request;
  const provenance = request.provenance ?? [];

  let bytes: Buffer;
  let printableHtml: string | undefined;

  switch (spec.kind) {
    case "document":
      bytes = await buildDocument(spec);
      break;
    case "spreadsheet":
      bytes = await buildSpreadsheet(spec);
      break;
    case "presentation":
      bytes = await buildPresentation(spec);
      break;
    case "report": {
      const rendered = buildReport(spec, provenance);
      bytes = Buffer.from(rendered.markdown, "utf8");
      printableHtml = rendered.html;
      break;
    }
    case "site":
      bytes = await buildSite(spec);
      break;
  }

  enforceByteCap(spec.kind, bytes.byteLength);
  const contentHash = contentHashFor(bytes);
  const validation = await validateDeliverable(spec.kind, bytes, options);

  return {
    kind: spec.kind,
    title: spec.title,
    mimeType: ARTIFACT_MIME[spec.kind],
    extension: ARTIFACT_EXTENSION[spec.kind],
    bytes,
    byteSize: bytes.byteLength,
    contentHash,
    provenance,
    validation,
    ...(printableHtml === undefined ? {} : { printableHtml }),
  };
}

// ---------------------------------------------------------------------------
// Storage and transport shapes
// ---------------------------------------------------------------------------

/**
 * Provenance rebuilt field by field for a JSONB column.
 *
 * The same construction `createRun` uses for `degradation`, and for the same
 * reason: an optional field that is absent must stay absent rather than land in
 * the column as `null`, which every reader would then have to handle as a third
 * state distinct from "missing" and "set".
 */
export function provenanceForStorage(
  provenance: readonly ProvenanceEntry[]
): Record<string, string>[] {
  return provenance.map((entry) => ({
    kind: entry.kind,
    label: entry.label,
    ...(entry.url === undefined ? {} : { url: entry.url }),
    ...(entry.ref === undefined ? {} : { ref: entry.ref }),
    ...(entry.retrievedAt === undefined ? {} : { retrievedAt: entry.retrievedAt }),
  }));
}

/**
 * Provenance read back out of a JSONB column.
 *
 * Entries this build cannot read are dropped rather than passed through, the
 * way `capabilityList` drops unknown capabilities in `work/serializers.ts`: a
 * citation whose kind is unrecognised is one the UI cannot render honestly, and
 * a half-rendered citation is worse than an absent one.
 */
export function provenanceFromStorage(raw: unknown): ProvenanceEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const parsed = provenanceEntrySchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

// Path separators, quotes, shell/Windows-reserved punctuation and control
// characters: anything that could break out of the filename or out of the
// Content-Disposition header it is interpolated into.
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME = /[\x00-\x1f\x7f"'\\/:*?<>|]/g;

export function sanitizeDeliverableName(raw: string): string {
  return raw
    .replace(UNSAFE_NAME, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "") // a leading dot would make it a hidden, extension-less file
    .slice(0, 80)
    .trim();
}

/** attr-char per RFC 5987 — encodeURIComponent leaves a few characters it forbids. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*!]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * The `Content-Disposition` a download responds with.
 *
 * Both forms are emitted: `filename=` stays ASCII for clients that predate RFC
 * 5987, and `filename*=` carries the real title. A title in a language with no
 * ASCII form would otherwise arrive as an empty name, and the file would be
 * saved as the URL's last path segment.
 *
 * Mirrors the helpers in `src/app/api/artifacts/[id]/export/route.ts`, which
 * keeps its copies private to that route. They are duplicated rather than
 * shared because sharing them means editing that route, which is outside this
 * milestone.
 */
export function attachmentDisposition(title: string, identifier: string, kind: WorkArtifactKind): string {
  const extension = ARTIFACT_EXTENSION[kind];
  const base = sanitizeDeliverableName(title) || sanitizeDeliverableName(identifier) || "deliverable";
  const ascii =
    base
      .replace(/[^\x20-\x7e]/g, "")
      .replace(/\s+/g, " ")
      .trim() || "deliverable";
  return (
    `attachment; filename="${ascii}.${extension}"; ` +
    `filename*=UTF-8''${encodeRfc5987(`${base}.${extension}`)}`
  );
}

/**
 * The HTTP status a `DeliverableError` deserves.
 *
 * Kept next to the codes rather than inside a route, because two routes answer
 * these and a second copy of the mapping is a second place a client error gets
 * reported as a server error.
 */
export function statusForDeliverableError(code: DeliverableErrorCode): number {
  switch (code) {
    case "invalid_spec":
    case "unsafe_path":
      return 400;
    case "too_large":
      return 413;
    case "build_failed":
      return 500;
  }
}

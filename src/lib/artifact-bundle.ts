import JSZip from "jszip";
import { extensionForLanguage } from "@/lib/artifact-runtime";
import { designPosterSvg } from "@/lib/design/poster";
import { buildHandoffBundle } from "@/lib/design/export";
import { parseStoredDesignDocument } from "@/lib/design/migrations";

/*
 * DOWNLOAD (PRODUCT_REFOUNDATION §10): an artifact as a file, or as a ZIP
 * bundle when it is more than one file.
 *
 * A design is the multi-file one today: its document (`.juno.design.json`,
 * what the editor opens and Juno imports), a picture of it (`poster.svg`), and
 * the Juno Code handoff bundle (`handoff.json`) the design editor already
 * builds. Every other type is one source file, and a ZIP of it (`format=zip`)
 * adds a README with its provenance. `history=1` adds every earlier version
 * under `history/`, capped so a long history cannot build an unbounded archive
 * in memory.
 *
 * GitHub export is deliberately not here (out of scope for this lane). Its
 * design, for the phase that builds it: reuse Juno Code's GitHub connection
 * (never a new token), write this same bundle's files to a new repository or
 * a gist through the connector, behind the always-confirm floor (it publishes
 * to a third party), recording the commit on the artifact as provenance.
 */

/** The extension each type is saved with when no language says better. */
export const ARTIFACT_FILE_EXTENSIONS: Record<string, string> = {
  HTML: "html",
  REACT: "tsx",
  SVG: "svg",
  MARKDOWN: "md",
  MERMAID: "mmd",
  DESIGN: "juno.design.json",
  CODE: "txt",
};

/** The largest archive `history=1` will build, in characters of source. */
export const BUNDLE_HISTORY_BUDGET_CHARS = 20_000_000;

export interface BundleArtifact {
  id: string;
  identifier: string;
  title: string;
  type: string;
  language: string | null;
  derivedFromId?: string | null;
  derivedFromVersion?: number | null;
}

/** A file name stem from the title, or the identifier when the title has none. */
export function artifactFileStem(artifact: Pick<BundleArtifact, "title" | "identifier">): string {
  const cleaned = artifact.title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned || artifact.identifier || "artifact";
}

/** The extension an artifact is saved with: its language's, else its type's. */
export function artifactFileExtension(artifact: Pick<BundleArtifact, "type" | "language">): string {
  return (
    (artifact.type === "CODE" || artifact.type === "REACT" ? extensionForLanguage(artifact.language) : null) ??
    ARTIFACT_FILE_EXTENSIONS[artifact.type] ??
    "txt"
  );
}

/** The one file an artifact is: its stem and its extension. */
export function artifactFileName(artifact: Pick<BundleArtifact, "title" | "identifier" | "type" | "language">): string {
  return `${artifactFileStem(artifact)}.${artifactFileExtension(artifact)}`;
}

export function artifactMimeType(type: string): string {
  switch (type) {
    case "HTML":
      return "text/html; charset=utf-8";
    case "SVG":
      return "image/svg+xml";
    case "MARKDOWN":
      return "text/markdown; charset=utf-8";
    case "DESIGN":
      return "application/json";
    default:
      return "text/plain; charset=utf-8";
  }
}

/** Whether an artifact of this type is more than one file (downloads as a ZIP by default). */
export function isMultiFileType(type: string): boolean {
  return type === "DESIGN";
}

export interface BundleInput {
  artifact: BundleArtifact;
  version: number;
  content: string;
  /** Earlier versions to include under history/, oldest first. */
  history?: Array<{ version: number; content: string; origin: string | null; createdAt: Date }>;
  now?: Date;
}

/**
 * The files of a bundle, before zipping: pure, so the layout is tested
 * without building an archive.
 */
export function bundleFiles(input: BundleInput): Array<{ path: string; content: string }> {
  const { artifact, version, content } = input;
  const now = (input.now ?? new Date()).toISOString();
  const files: Array<{ path: string; content: string }> = [];
  const main = artifactFileName(artifact);
  files.push({ path: main, content });

  if (artifact.type === "DESIGN") {
    const poster = designPosterSvg(content);
    if (poster) files.push({ path: "poster.svg", content: poster });
    try {
      const document = parseStoredDesignDocument(content);
      const pageId = document.pages[0]?.id;
      if (pageId) files.push({ path: "handoff.json", content: JSON.stringify(buildHandoffBundle(document, pageId, now), null, 2) });
    } catch {
      // A document this build cannot read still downloads as its source; the
      // picture and the handoff are what it could not be turned into.
    }
  }

  let budget = BUNDLE_HISTORY_BUDGET_CHARS;
  const history = (input.history ?? []).filter((row) => row.version !== version);
  const included: number[] = [];
  for (const row of history) {
    if (row.content.length > budget) break;
    budget -= row.content.length;
    files.push({ path: `history/v${row.version}.${artifactFileExtension(artifact)}`, content: row.content });
    included.push(row.version);
  }

  const lines = [
    `# ${artifact.title || artifact.identifier}`,
    "",
    `- Type: ${artifact.type}${artifact.language ? ` (${artifact.language})` : ""}`,
    `- Version: ${version}`,
    `- Exported: ${now}`,
    `- Juno artifact: ${artifact.id}`,
  ];
  if (artifact.derivedFromId) {
    lines.push(`- Copied from: ${artifact.derivedFromId}${artifact.derivedFromVersion ? ` (version ${artifact.derivedFromVersion})` : ""}`);
  }
  lines.push("", `\`${main}\` is the source.`);
  if (artifact.type === "DESIGN") {
    lines.push("`poster.svg` is a picture of its first page; `handoff.json` is the Juno Code handoff bundle.");
  }
  if (included.length > 0) lines.push(`\`history/\` holds versions ${included.join(", ")}.`);
  if (history.length > included.length) {
    lines.push(`Older versions were left out to keep the archive under ${BUNDLE_HISTORY_BUDGET_CHARS.toLocaleString("en-US")} characters.`);
  }
  files.push({ path: "README.md", content: `${lines.join("\n")}\n` });
  return files;
}

export async function buildArtifactZip(input: BundleInput): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const file of bundleFiles(input)) zip.file(file.path, file.content);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

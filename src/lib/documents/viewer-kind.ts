/**
 * Which viewer a file opens in, and what the viewer calls it.
 *
 * Pure and dependency-free: the transcript tile, the side viewer and the tests
 * all ask the same question, and the answer must not depend on who asked.
 *
 * The EXTENSION leads and the MIME type follows, for the reason
 * `knowledge/extract/index.ts` gives: senders label files inconsistently, and a
 * `.docx` from a machine without Office arrives as `application/octet-stream`.
 * The name is the evidence that survives a wrong label.
 */

export type ViewerKind =
  /** Drawn page by page with a selectable text layer. */
  | "pdf"
  /** Zoomable, with an area selection for the part you want to ask about. */
  | "image"
  /** The file's own characters: prose, data, source. */
  | "text"
  /** An office document read into a clean reading view from its structure. */
  | "document"
  | "video"
  | "audio"
  /** Nothing to show beyond its name — the viewer offers the download. */
  | "unsupported";

export interface ViewableFile {
  kind: "IMAGE" | "FILE";
  fileName: string;
  mimeType: string;
}

const OFFICE_EXTENSIONS = new Set([
  "docx", "docm", "pptx", "pptm", "xlsx", "xlsm", "odt", "ods", "odp", "fodt", "rtf",
]);

const OFFICE_MIME_PREFIXES = [
  "application/vnd.openxmlformats-officedocument.",
  "application/vnd.ms-word.",
  "application/vnd.ms-excel.",
  "application/vnd.ms-powerpoint.",
  "application/vnd.oasis.opendocument.",
  "application/rtf",
  "text/rtf",
];

/** Prose, data and source — what `uploads.ts` accepts as readable text. */
const TEXT_EXTENSIONS = new Set([
  "txt", "text", "log", "md", "markdown", "mdx", "csv", "tsv", "json", "jsonc",
  "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt",
  "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "sql",
  "css", "scss", "less", "gradle", "graphql", "proto", "tex", "r", "lua", "dart",
  "scala", "pl", "vue", "svelte",
]);

const TEXT_MIME = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-yaml",
  "application/yaml",
  "application/sql",
  "application/toml",
]);

/** The extension, lowercased, or "" for a name that has none. */
export function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 && dot < fileName.length - 1 ? fileName.slice(dot + 1).toLowerCase() : "";
}

export function viewerKindOf(file: ViewableFile): ViewerKind {
  const ext = fileExtension(file.fileName);
  const mime = file.mimeType.toLowerCase().split(";")[0].trim();

  if (file.kind === "IMAGE") return "image";
  if (ext === "pdf" || mime === "application/pdf") return "pdf";
  if (OFFICE_EXTENSIONS.has(ext)) return "document";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (OFFICE_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))) return "document";
  if (mime.startsWith("text/") || TEXT_MIME.has(mime)) return "text";
  // A picture that was stored as a file (never re-sniffed as IMAGE) is still a
  // picture — but only the formats the upload gate would have accepted.
  if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime)) return "image";
  return "unsupported";
}

export type TextFlavor = "markdown" | "csv" | "tsv" | "code" | "plain";

export function textFlavorOf(fileName: string): TextFlavor {
  const ext = fileExtension(fileName);
  if (ext === "md" || ext === "markdown" || ext === "mdx") return "markdown";
  if (ext === "csv") return "csv";
  if (ext === "tsv") return "tsv";
  if (ext === "txt" || ext === "text" || ext === "log" || ext === "") return "plain";
  return "code";
}

/** What the viewer's header calls the file, in a reader's words. */
export function formatLabelOf(file: ViewableFile): string {
  const ext = fileExtension(file.fileName);
  switch (viewerKindOf(file)) {
    case "pdf":
      return "PDF";
    case "image":
      return "Image";
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    case "document":
      if (ext === "docx" || ext === "docm") return "Word document";
      if (ext === "pptx" || ext === "pptm") return "PowerPoint deck";
      if (ext === "xlsx" || ext === "xlsm") return "Excel workbook";
      if (ext === "odt" || ext === "fodt") return "OpenDocument text";
      if (ext === "ods") return "OpenDocument spreadsheet";
      if (ext === "odp") return "OpenDocument presentation";
      if (ext === "rtf") return "Rich text";
      return "Document";
    case "text": {
      const flavor = textFlavorOf(file.fileName);
      if (flavor === "markdown") return "Markdown";
      if (flavor === "csv") return "CSV";
      if (flavor === "tsv") return "TSV";
      if (flavor === "plain") return "Text";
      return ext ? ext.toUpperCase() : "Code";
    }
    default:
      return ext ? ext.toUpperCase() : "File";
  }
}

/**
 * One delimited line split into cells — quotes honoured, doubled quotes
 * unescaped. Enough for the viewer's table; it does not need to be a complete
 * RFC 4180 parser, because a line that trips it still shows as text in a cell.
 */
export function splitDelimitedLine(line: string, delimiter: "," | "\t"): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === "") {
      quoted = true;
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

/** A table block from the extractors ("a | b | c" rows joined by newlines) back into cells. */
export function splitPipeTable(text: string): string[][] {
  return text
    .split("\n")
    .filter((row) => row.trim().length > 0)
    .map((row) => row.split(" | ").map((cell) => cell.trim()));
}

/**
 * Case-insensitive occurrences of `query` in `haystack`, as [start, end) pairs.
 * Non-overlapping, left to right — the order a find bar steps through them.
 */
export function findOccurrences(haystack: string, query: string, limit = 5000): Array<[number, number]> {
  const needle = query.toLocaleLowerCase();
  if (!needle.trim()) return [];
  const hay = haystack.toLocaleLowerCase();
  // Lowercasing can change a string's length (İ → i̇). Where it did, offsets into
  // the lowered copy no longer point at the original, so fall back to an exact
  // search rather than highlight the wrong characters.
  const lowered = hay.length === haystack.length;
  const source = lowered ? hay : haystack;
  const target = lowered ? needle : query;
  const out: Array<[number, number]> = [];
  let from = 0;
  while (out.length < limit) {
    const at = source.indexOf(target, from);
    if (at === -1) break;
    out.push([at, at + target.length]);
    from = at + Math.max(target.length, 1);
  }
  return out;
}

/**
 * A PDF passage as prose.
 *
 * pdf.js's text layer ends every DRAWN line with a break, so a selected
 * paragraph arrives as "…and report\nresults on three…" — the page's line
 * wrapping, not the author's. A break is joined only where it plainly falls
 * inside a sentence (a lowercase letter or a comma before it, a lowercase
 * word after it), and a word split with a hyphen across two lines is mended.
 * Everything else — a sentence end, a heading, a table row, a list — keeps its
 * break, because a wrong join there would merge two things the page kept apart.
 */
export function joinSoftWraps(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/([a-z])-\n(?=[a-z])/g, "$1")
    .replace(/([a-z,;])[ \t]*\n[ \t]*(?=[a-z(])/g, "$1 ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

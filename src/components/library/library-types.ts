import type { KnowledgeIndexState } from "@/components/library/index-status";

/**
 * The Library's data, as `/api/library` returns it.
 *
 * Kept apart from the components so the page, its data hook and the dev
 * fixture page (`/dev/library`) all describe one row the same way.
 */
export interface LibraryItem {
  id: string;
  kind: "IMAGE" | "FILE";
  fileName: string;
  mimeType: string;
  size: number;
  url: string;
  createdAt: string;
  conversationId: string | null;
  version: number;
  versionCount: number;
  origin: string;
  parserState: string;
  parserVersion: string | null;
  deletedAt: string | null;
  /** What indexing made of the file; null for files no extractor claims. */
  knowledge: KnowledgeIndexState | null;
}

export interface LibraryVersion {
  version: number;
  current: boolean;
  origin: string;
  fileName: string;
  mimeType: string;
  size: number;
  parserState: string;
  createdAt: string;
  url: string;
}

export type LibraryKind = "all" | LibraryItem["kind"];
export type LibrarySort = "newest" | "oldest" | "name" | "size";
export type LibraryView = "list" | "grid";

export interface LibraryCounts {
  all: number;
  IMAGE: number;
  FILE: number;
}

export interface LibraryStorage {
  usedBytes: number;
  quotaBytes: number;
  remainingBytes: number;
}

/**
 * A file on its way up. It has no server id yet, so it is its own shape
 * rather than a `LibraryItem` with holes in it; the row that draws it never
 * offers an action that needs one.
 */
export interface LibraryUpload {
  localId: string;
  fileName: string;
  size: number;
  kind: LibraryItem["kind"];
  /** 0 to 100, bytes sent. 100 while the server stores and records the file. */
  progress: number;
  status: "uploading" | "failed";
  error?: string;
  /** False when trying again cannot help: the type or size was refused. */
  retryable?: boolean;
  /** An object URL for an image, so its thumbnail is there before the bytes are. */
  previewUrl?: string;
}

/** "report.final.pdf" → "PDF"; a name with no usable extension says what kind of thing it is. */
export function typeLabel(item: { fileName: string; kind: LibraryItem["kind"] }) {
  const extension = item.fileName.includes(".") ? item.fileName.split(".").pop()?.trim() : "";
  if (extension && extension.length <= 8) return extension.toUpperCase();
  return item.kind === "IMAGE" ? "Image" : "File";
}

/** Named `…_LABEL` so the i18n extractor collects every word in it. */
const KIND_LABEL: Record<string, string> = {
  image: "Image",
  code: "Code",
  file: "File",
  pdf: "PDF",
  doc: "Document",
  docx: "Document",
  rtf: "Document",
  odt: "Document",
  pages: "Document",
  txt: "Text",
  md: "Text",
  markdown: "Text",
  xls: "Spreadsheet",
  xlsx: "Spreadsheet",
  csv: "Spreadsheet",
  tsv: "Spreadsheet",
  numbers: "Spreadsheet",
  ppt: "Presentation",
  pptx: "Presentation",
  key: "Presentation",
  json: "Data",
  xml: "Data",
  yaml: "Data",
  yml: "Data",
  mov: "Video",
  mp4: "Video",
  webm: "Video",
  mp3: "Audio",
  wav: "Audio",
  m4a: "Audio",
  zip: "Archive",
};

const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc",
  "cpp", "hpp", "cs", "php", "sh", "sql", "html", "css", "scss", "vue", "svelte", "lua", "r", "scala",
]);

/**
 * What KIND of file this is, in a word: the Type column, the way Finder's
 * Kind column reads. The thumbnail beside it already prints the extension, so
 * a column repeating "PDF" under "PDF" said one thing twice; "Spreadsheet" or
 * "Code" says the thing a reader scanning the column is looking for.
 */
export function kindLabel(item: { fileName: string; kind: LibraryItem["kind"] }) {
  if (item.kind === "IMAGE") return KIND_LABEL.image;
  const dot = item.fileName.lastIndexOf(".");
  const extension = dot > 0 ? item.fileName.slice(dot + 1).toLowerCase() : "";
  if (CODE_EXTENSIONS.has(extension)) return KIND_LABEL.code;
  return (extension && KIND_LABEL[extension]) || KIND_LABEL.file;
}

/**
 * The server's orderings, restated for the one place the client has to place
 * a row itself: putting an item back after Undo, or a finished upload into a
 * list it did not come from. Must agree with `ORDER_BY` in library-query.ts.
 */
export function compareItems(sort: LibrarySort): (a: LibraryItem, b: LibraryItem) => number {
  switch (sort) {
    case "oldest":
      return (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
    case "name":
      return (a, b) =>
        a.fileName.localeCompare(b.fileName, undefined, { sensitivity: "base", numeric: true }) ||
        a.id.localeCompare(b.id);
    case "size":
      return (a, b) => b.size - a.size || b.id.localeCompare(a.id);
    default:
      return (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
  }
}

/** Whether a row belongs in the list the reader is looking at. Mirrors the route's `where`. */
export function matchesView(item: LibraryItem, view: { q: string; kind: LibraryKind }) {
  if (view.kind !== "all" && item.kind !== view.kind) return false;
  const q = view.q.trim().toLocaleLowerCase();
  return !q || item.fileName.toLocaleLowerCase().includes(q);
}

/**
 * Merge rows into an already-sorted list, free of duplicates.
 *
 * Each row goes in front of the first item it sorts before. The list itself is
 * never re-sorted: its order came from the database, whose collation need not
 * agree with `localeCompare` on every name, and rows the reader is looking at
 * must not trade places because one file came back.
 *
 * `hasMore`: the list is a window onto a longer one. A row that sorts past its
 * last item belongs to a page not loaded yet and will arrive with it, so it is
 * left out rather than drawn at the bottom of the wrong page.
 */
export function insertSorted(
  list: LibraryItem[],
  rows: LibraryItem[],
  sort: LibrarySort,
  hasMore = false,
): LibraryItem[] {
  if (rows.length === 0) return list;
  const compare = compareItems(sort);
  const incoming = new Set(rows.map((row) => row.id));
  const next = list.filter((item) => !incoming.has(item.id));
  for (const row of [...rows].sort(compare)) {
    const at = next.findIndex((item) => compare(row, item) < 0);
    if (at !== -1) next.splice(at, 0, row);
    else if (!hasMore) next.push(row);
  }
  return next;
}

/**
 * The reading view's wire shape — `GET /api/attachments/<id>/document`.
 *
 * Kept apart from `reader.ts`, which is server-only, so the client viewer can
 * import the types without dragging Prisma into the bundle.
 */

export type ReaderBlockType =
  | "paragraph"
  | "heading"
  | "list_item"
  | "table"
  | "slide_title"
  | "speaker_notes"
  | "code"
  | "caption"
  | "image";

export interface ReaderBlock {
  type: ReaderBlockType;
  text: string;
  /** 1-based page, where the format records one (PDF, or a Word file that was laid out). */
  page?: number;
  slide?: number;
  sheet?: string;
  /** Heading depth, 1 = the document's top level. Only on `heading`. */
  level?: number;
}

/** One worksheet as displayed values, already trimmed to its used range. */
export interface ReaderSheet {
  name: string;
  rows: string[][];
}

export interface ReaderDocument {
  /** `partial`: readable, but the extractor knew it missed something (see `note`). */
  status: "ready" | "partial" | "empty";
  /** Where the structure came from — the search index, or the file read just now. */
  source: "index" | "file";
  blocks: ReaderBlock[];
  /** Workbooks only: grids instead of blocks. */
  sheets?: ReaderSheet[];
  pageCount: number | null;
  /** More existed than the view carries. */
  truncated: boolean;
  /** The extractor's own sentence, when it had one worth showing. */
  note?: string;
}

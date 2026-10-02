/*
 * "Everything Juno made", as one Library list (PRODUCT_REFOUNDATION §3, §10):
 * chat artifacts (`Artifact`) and the Office and other deliverables tasks
 * produce (`WorkArtifact`), in one newest-first list with a `kind` and a
 * `type` on every item. Read-only references to deliverables: their storage,
 * validation and download stay where they are (/api/work/artifacts/*).
 *
 * The list is keyset-paginated on (updatedAt desc, id desc) across both
 * tables: each page asks each table for the rows after the cursor, merges,
 * and keeps the first `limit`. A cursor is a position, not a row id, so a row
 * edited while someone scrolls moves to the top instead of shifting the page.
 *
 * Pure: the cursor codec and the merge are tested without a database.
 */

export type LibraryMadeKind = "artifact" | "deliverable";

export interface LibraryMadeItem {
  kind: LibraryMadeKind;
  id: string;
  /** Artifact: its type (HTML, DESIGN, …). Deliverable: DOCUMENT, SPREADSHEET, PRESENTATION, … */
  type: string;
  title: string;
  version: number;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Where the item opens: an artifact's page, or a deliverable's download. */
  href: string;
  /** Artifact: its chat, when it still has one. Deliverable: its task's chat. */
  conversationId: string | null;
  /** Deliverable only: its MIME type and whether the validator re-opened it. */
  mimeType?: string;
  validated?: boolean;
  /**
   * The agent whose thread or task made it, when one did (its chat is an agent
   * thread, or its task ran for an agent). Absent for things made in an
   * ordinary chat. Name and face only: the Library's byline, nothing more.
   */
  agent?: LibraryMadeAgent;
  /** Artifact only: the opening of its newest version, for the Library's miniature. */
  preview?: string | null;
}

export interface LibraryMadeAgent {
  id: string;
  name: string;
  /** The stored `{shape, tone, eyes, mark}`; the client normalises it. */
  avatar: unknown;
}

export interface LibraryCursor {
  updatedAt: Date;
  id: string;
}

export function encodeLibraryMadeCursor(cursor: LibraryCursor): string {
  return Buffer.from(JSON.stringify({ u: cursor.updatedAt.toISOString(), i: cursor.id })).toString("base64url");
}

export function decodeLibraryMadeCursor(raw: string | null | undefined): LibraryCursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { u?: unknown; i?: unknown };
    if (typeof value.u !== "string" || typeof value.i !== "string" || !value.i) return null;
    const updatedAt = new Date(value.u);
    if (Number.isNaN(updatedAt.getTime())) return null;
    return { updatedAt, id: value.i };
  } catch {
    return null;
  }
}

/** The Prisma `where` fragment for "after this cursor" on (updatedAt desc, id desc). */
export function afterCursorWhere(cursor: LibraryCursor | null) {
  if (!cursor) return {};
  return {
    OR: [{ updatedAt: { lt: cursor.updatedAt } }, { updatedAt: cursor.updatedAt, id: { lt: cursor.id } }],
  };
}

/** Newest first, id breaking ties, the order the cursor walks. */
export function compareLibraryItems(a: LibraryMadeItem, b: LibraryMadeItem): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/**
 * Merge each table's page into one page of `limit`, and the cursor for the
 * next. Each table was asked for `limit + 1` rows after the cursor, so a full
 * page means there may be more.
 */
export function mergeLibraryPages(
  pages: ReadonlyArray<ReadonlyArray<LibraryMadeItem>>,
  limit: number
): { items: LibraryMadeItem[]; nextCursor: string | null } {
  const merged = pages.flat().sort(compareLibraryItems);
  const items = merged.slice(0, limit);
  const more = merged.length > limit;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: more && last ? encodeLibraryMadeCursor({ updatedAt: new Date(last.updatedAt), id: last.id }) : null,
  };
}

/** A deliverable's `kind` as a Library type: "spreadsheet" → "SPREADSHEET". */
export function deliverableType(kind: string): string {
  return kind.toUpperCase();
}

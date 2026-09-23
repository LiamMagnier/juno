import type { Prisma } from "@prisma/client";
import type { LibrarySort } from "@/components/library/library-types";

/**
 * How `/api/library` turns its parameters into a query: the sorts, the search
 * pattern and the page cursor. Pure functions, apart from the route, so the
 * parts that are easy to get subtly wrong have tests of their own.
 */

/**
 * The orderings the Library offers. Each ends on `id` so two rows with the same
 * key (two files added in one second, two files with one name) still have a
 * fixed order, which is what lets a cursor resume exactly where a page stopped.
 * `compareItems` in library-types.ts restates these for the client.
 */
const ORDER_BY = {
  newest: [{ createdAt: "desc" }, { id: "desc" }],
  oldest: [{ createdAt: "asc" }, { id: "asc" }],
  name: [{ fileName: "asc" }, { id: "asc" }],
  size: [{ size: "desc" }, { id: "desc" }],
} satisfies Record<LibrarySort, Prisma.AttachmentOrderByWithRelationInput[]>;

/**
 * `hasOwn`, not `in`: `"constructor" in ORDER_BY` is true, and a `sort` that
 * reached Prisma as `Object` was a 500 instead of the default order.
 */
export function parseLibrarySort(raw: string | null): LibrarySort {
  return raw && Object.hasOwn(ORDER_BY, raw) ? (raw as LibrarySort) : "newest";
}

export function libraryOrderBy(sort: LibrarySort): Prisma.AttachmentOrderByWithRelationInput[] {
  return ORDER_BY[sort];
}

/**
 * The search text as a literal inside a LIKE pattern.
 *
 * Prisma's `contains` wraps the value in `%…%` and passes it through as is, so
 * `_` and `%` in it are wildcards: "report_v2" matched "report-v2" and
 * "report v2", and a search for "_" matched every file. Backslash is
 * Postgres's default LIKE escape, so it is escaped first.
 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** The fields a cursor records: a row's sort key and its id. */
export interface LibraryCursorRow {
  id: string;
  createdAt: Date;
  fileName: string;
  size: number;
}

interface CursorPosition {
  sort: LibrarySort;
  /** The sort key's value: an ISO date, a file name or a byte count. */
  key: string | number;
  id: string;
}

function keyOf(sort: LibrarySort, row: LibraryCursorRow): string | number {
  if (sort === "name") return row.fileName;
  if (sort === "size") return row.size;
  return row.createdAt.toISOString();
}

/**
 * The cursor for the page after `row`: the row's POSITION (its sort key and
 * id), not a reference to the row.
 *
 * It used to be the id alone, handed to Prisma's `cursor`, which looks the row
 * up by id and skips one row. That went wrong three ways. The lookup is not
 * scoped to the reader, so any attachment id, anyone's, positioned the list:
 * with name and size sorts that let a reader learn another account's file
 * name and size by where their own files landed around it. The skip assumes
 * the cursor row is still in the result, so deleting the last file on screen
 * (or restoring it, in Recently deleted) made the next page silently drop the
 * file after it. And a renamed last row moved the cursor with it. A position
 * carried in the cursor has none of those problems.
 */
export function encodeLibraryCursor(sort: LibrarySort, row: LibraryCursorRow): string {
  return Buffer.from(JSON.stringify([sort, keyOf(sort, row), row.id])).toString("base64url");
}

/**
 * Null for anything that is not a cursor this sort wrote, including a
 * well-formed cursor from another sort: resuming "Largest first" from a
 * position in "Name" would return a page from the middle of nowhere.
 */
export function decodeLibraryCursor(sort: LibrarySort, raw: string): CursorPosition | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) return null;
  const [cursorSort, key, id] = parsed as unknown[];
  if (cursorSort !== sort || typeof id !== "string" || id.length === 0) return null;
  if (sort === "size") {
    return typeof key === "number" && Number.isSafeInteger(key) ? { sort, key, id } : null;
  }
  if (typeof key !== "string") return null;
  if (sort !== "name" && Number.isNaN(Date.parse(key))) return null;
  return { sort, key, id };
}

/** The same position, from a row the route looked up itself (a bare-id cursor). */
export function cursorPositionOf(sort: LibrarySort, row: LibraryCursorRow): CursorPosition {
  return { sort, key: keyOf(sort, row), id: row.id };
}

/**
 * Rows strictly after `position` in its sort's order: the key past the
 * cursor's, or the same key and a later id. Written out rather than left to
 * Prisma's `cursor`, so the cursor row itself need not exist or match.
 */
export function libraryRowsAfter(position: CursorPosition): Prisma.AttachmentWhereInput {
  const { sort, key, id } = position;
  switch (sort) {
    case "newest": {
      const at = new Date(key as string);
      return { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: id } }] };
    }
    case "oldest": {
      const at = new Date(key as string);
      return { OR: [{ createdAt: { gt: at } }, { createdAt: at, id: { gt: id } }] };
    }
    case "name":
      return { OR: [{ fileName: { gt: key as string } }, { fileName: key as string, id: { gt: id } }] };
    case "size":
      return { OR: [{ size: { lt: key as number } }, { size: key as number, id: { lt: id } }] };
  }
}

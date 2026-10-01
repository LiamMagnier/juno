import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { insertSorted, matchesView, type LibraryItem, type LibrarySort } from "@/components/library/library-types";
import {
  decodeLibraryCursor,
  encodeLibraryCursor,
  escapeLike,
  libraryOrderBy,
  libraryRowsAfter,
  parseLibrarySort,
  type LibraryCursorRow,
} from "@/components/library/library-query";
import { quickListModels, QUICK_LIST_MAX } from "@/lib/model-picker";
import { MODELS, type ModelInfo } from "@/lib/models";
import { AUTO_MODEL_ID } from "@/lib/auto-model";

const ROUTE = readFileSync(new URL("../src/app/api/library/route.ts", import.meta.url), "utf8");
const PAGE = readFileSync(new URL("../src/app/(app)/library/page.tsx", import.meta.url), "utf8");
const LIBRARY_HOME = readFileSync(new URL("../src/components/library/library-home.tsx", import.meta.url), "utf8");
const LIBRARY_FILES = readFileSync(new URL("../src/components/library/library-files-page.tsx", import.meta.url), "utf8");
const LIBRARY_TRASH = readFileSync(new URL("../src/components/library/library-trash.tsx", import.meta.url), "utf8");

/*
 * The Library's search, filter and sort run on the server, and the page puts
 * rows back (Undo, a finished upload) with the client's copy of the same
 * ordering. These pin the two halves to each other, and the model menu's
 * short list to the rules its comment states.
 */

function item(id: string, patch: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id,
    kind: "FILE",
    fileName: `${id}.pdf`,
    mimeType: "application/pdf",
    size: 1000,
    url: "",
    createdAt: "2026-09-01T00:00:00.000Z",
    conversationId: null,
    version: 1,
    versionCount: 0,
    origin: "upload",
    parserState: "ready",
    parserVersion: null,
    deletedAt: null,
    inUse: null,
    keptIn: null,
    knowledge: null,
    ...patch,
  };
}

test("the library route searches, filters and sorts in the database", () => {
  assert.match(ROUTE, /fileName: \{ contains: escapeLike\(q\), mode: "insensitive" \}/);
  assert.match(ROUTE, /orderBy: libraryOrderBy\(sort\)/);
  assert.match(ROUTE, /parseLibrarySort\(searchParams\.get\("sort"\)\)/);
  // Counts and the storage figure are for the whole result, not the page.
  assert.match(ROUTE, /groupBy\(\{ by: \["kind"\]/);
  assert.match(ROUTE, /storage: \{ usedBytes, quotaBytes/);
  // Prisma's own `cursor` looks the row up unscoped and skips one row; the
  // route pages by position instead (see the keyset tests below).
  assert.doesNotMatch(ROUTE, /cursor: \{ id/);
  assert.doesNotMatch(ROUTE, /skip: 1/);
});

test("the library page keeps the e2e contract: an h1 that says library", () => {
  // /library with no view opens the unified Library, whose page header (an
  // h1, AppPageHeader) says Library; the e2e suite visits exactly that URL.
  assert.match(PAGE, /return params\.get\("view"\) === "files" \? <LibraryFilesPage \/> : <LibraryHome \/>;/);
  assert.match(LIBRARY_HOME, /<AppPageHeader heading="Library"/);
  // The other views keep their own headings, and both stay reachable from it.
  assert.match(PAGE, /if \(params\.get\("view"\) === "trash"\) return <LibraryTrash \/>;/);
  assert.match(LIBRARY_TRASH, /<AppPageHeader heading="Recently deleted"/);
  assert.match(LIBRARY_FILES, /heading=\{deletedView \? "Recently deleted" : "Uploaded files"\}/);
  assert.match(LIBRARY_HOME, /href="\/library\?view=trash"/);
  assert.match(LIBRARY_HOME, /href="\/library\?view=files&upload=1"/);
});

test("a sort the route does not offer falls back to newest, prototype keys included", () => {
  for (const sort of ["newest", "oldest", "name", "size"] as const) assert.equal(parseLibrarySort(sort), sort);
  for (const raw of [null, "", "constructor", "toString", "__proto__", "hasOwnProperty", "NAME"]) {
    assert.equal(parseLibrarySort(raw), "newest", `sort=${raw}`);
  }
});

test("search text is literal inside the LIKE pattern", () => {
  assert.equal(escapeLike("report_v2"), "report\\_v2");
  assert.equal(escapeLike("100%"), "100\\%");
  assert.equal(escapeLike("a\\b"), "a\\\\b");
  assert.equal(escapeLike("Q3 board report.pdf"), "Q3 board report.pdf");
});

test("a cursor only resumes the sort that wrote it, and nothing else parses as one", () => {
  const row: LibraryCursorRow = { id: "ck1", createdAt: new Date("2026-09-01T10:00:00.123Z"), fileName: "Q3.pdf", size: 42 };
  const expected = { newest: row.createdAt.toISOString(), oldest: row.createdAt.toISOString(), name: "Q3.pdf", size: 42 };
  for (const sort of ["newest", "oldest", "name", "size"] as const) {
    const cursor = encodeLibraryCursor(sort, row);
    assert.deepEqual(decodeLibraryCursor(sort, cursor), { sort, key: expected[sort], id: "ck1" });
    for (const other of ["newest", "oldest", "name", "size"] as const) {
      if (other !== sort) assert.equal(decodeLibraryCursor(other, cursor), null, `${sort} cursor under ${other}`);
    }
  }
  const forged = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const rejected: [LibrarySort, string][] = [
    ["newest", "ck1"], // a bare id: the route looks it up itself, scoped to the reader
    ["newest", ""],
    ["newest", "not base64 at all"],
    ["size", forged(["size", "42", "ck1"])],
    ["size", forged(["size", 1.5, "ck1"])],
    ["newest", forged(["newest", "yesterday", "ck1"])],
    ["name", forged(["name", "Q3.pdf", ""])],
    ["name", forged({ sort: "name" })],
  ];
  for (const [sort, raw] of rejected) assert.equal(decodeLibraryCursor(sort, raw), null, raw);
});

/**
 * Enough of Prisma's `where` and `orderBy` to page an array the way the route
 * pages the table: equality, `lt`/`gt`, `OR`. Strings compare by code unit,
 * which is what matters here: the keyset and the ordering must agree with
 * EACH OTHER, whatever the collation.
 */
type Row = LibraryCursorRow & { deleted?: boolean };
function matchesWhere(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, condition]) => {
    if (field === "OR") return (condition as Record<string, unknown>[]).some((branch) => matchesWhere(row, branch));
    const value = row[field as keyof LibraryCursorRow];
    const norm = (v: unknown) => (v instanceof Date ? v.getTime() : (v as string | number));
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      const { lt, gt } = condition as { lt?: unknown; gt?: unknown };
      if (lt !== undefined && !(norm(value) < norm(lt))) return false;
      if (gt !== undefined && !(norm(value) > norm(gt))) return false;
      return true;
    }
    return norm(value) === norm(condition);
  });
}
function sortRows(rows: Row[], sort: LibrarySort): Row[] {
  const keys = libraryOrderBy(sort).map((entry) => Object.entries(entry)[0] as [keyof LibraryCursorRow, "asc" | "desc"]);
  return [...rows].sort((a, b) => {
    for (const [field, direction] of keys) {
      const x = a[field] instanceof Date ? (a[field] as Date).getTime() : a[field];
      const y = b[field] instanceof Date ? (b[field] as Date).getTime() : b[field];
      if (x !== y) return (x < y ? -1 : 1) * (direction === "asc" ? 1 : -1);
    }
    return 0;
  });
}
function page(rows: Row[], sort: LibrarySort, cursor: string | null, size: number) {
  const position = cursor ? decodeLibraryCursor(sort, cursor) : null;
  const after = position ? libraryRowsAfter(position) : null;
  const visible = rows.filter((row) => !row.deleted && (!after || matchesWhere(row, after as Record<string, unknown>)));
  const out = sortRows(visible, sort).slice(0, size + 1);
  const more = out.length > size;
  const pageRows = out.slice(0, size);
  return { rows: pageRows, next: more ? encodeLibraryCursor(sort, pageRows[pageRows.length - 1]) : null };
}

test("paging resumes after the last row even when that row has left the list", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 10, minute));
  // Ties on every key, so the id tiebreak is exercised under each sort.
  const fixture: Row[] = [
    { id: "a", createdAt: at(1), fileName: "b.pdf", size: 10 },
    { id: "b", createdAt: at(1), fileName: "a.pdf", size: 30 },
    { id: "c", createdAt: at(2), fileName: "b.pdf", size: 30 },
    { id: "d", createdAt: at(3), fileName: "c.pdf", size: 20 },
    { id: "e", createdAt: at(3), fileName: "a.pdf", size: 10 },
    { id: "f", createdAt: at(4), fileName: "d.pdf", size: 20 },
  ];
  for (const sort of ["newest", "oldest", "name", "size"] as const) {
    const all = sortRows(fixture, sort).map((row) => row.id);

    // Untouched, two pages of three are the whole list in order.
    const first = page(fixture, sort, null, 3);
    const second = page(fixture, sort, first.next, 3);
    assert.deepEqual([...first.rows, ...second.rows].map((row) => row.id), all, sort);
    assert.equal(second.next, null);

    // The last row on screen is deleted before the next page is asked for.
    // Prisma's `cursor` + `skip: 1` dropped the row after it; a position does not.
    const rows = fixture.map((row) => ({ ...row }));
    const lastShown = first.rows[first.rows.length - 1].id;
    rows.find((row) => row.id === lastShown)!.deleted = true;
    const resumed = page(rows, sort, first.next, 3);
    assert.deepEqual(resumed.rows.map((row) => row.id), all.slice(3), `${sort} after deleting the cursor row`);
  }
});

test("a row put back lands in sort order without reordering the rows around it", () => {
  const list = [
    item("c", { createdAt: "2026-09-03T00:00:00.000Z" }),
    item("a", { createdAt: "2026-09-01T00:00:00.000Z" }),
  ];
  const back = item("b", { createdAt: "2026-09-02T00:00:00.000Z" });
  assert.deepEqual(
    insertSorted(list, [back], "newest").map((row) => row.id),
    ["c", "b", "a"],
  );
  // Already present: replaced, never duplicated.
  assert.equal(insertSorted(list, [list[0]], "newest").length, 2);
});

test("a row that sorts past a partial list waits for its own page", () => {
  const list = [item("new", { createdAt: "2026-09-05T00:00:00.000Z" })];
  const old = item("old", { createdAt: "2026-01-01T00:00:00.000Z" });
  assert.deepEqual(insertSorted(list, [old], "newest", true).map((row) => row.id), ["new"]);
  assert.deepEqual(insertSorted(list, [old], "newest", false).map((row) => row.id), ["new", "old"]);
});

test("the client's view test mirrors the route's where", () => {
  const photo = item("p", { kind: "IMAGE", fileName: "Holiday.PNG" });
  assert.equal(matchesView(photo, { q: "holi", kind: "all" }), true);
  assert.equal(matchesView(photo, { q: "holi", kind: "FILE" }), false);
  assert.equal(matchesView(photo, { q: "report", kind: "all" }), false);
});

const model = (id: string, patch: Partial<ModelInfo> = {}): ModelInfo => ({ ...MODELS[id], ...patch });
const opus = model("anthropic:claude-opus-5-5");
const sonnet = model("anthropic:claude-sonnet-5");
const sol = model("openai:gpt-6-sol");
const flash = model("google:gemini-3.8-flash");
const haiku = model("anthropic:claude-haiku-4-5");
const luna = model("openai:gpt-6-luna");
const all = [opus, sonnet, sol, flash, haiku, luna];

test("stage one lists favourites, then recents, without repeats", () => {
  const ids = quickListModels({
    models: all,
    favorites: [opus.id, sol.id],
    recent: [sol.id, flash.id],
    currentId: opus.id,
  }).map((m) => m.id);
  assert.deepEqual(ids, [opus.id, sol.id, flash.id]);
});

test("the current model always has a row, taking the last slot when the list is full", () => {
  const ids = quickListModels({
    models: all,
    favorites: [opus.id, sonnet.id, sol.id, flash.id, haiku.id],
    recent: [],
    currentId: luna.id,
  }).map((m) => m.id);
  assert.equal(ids.length, QUICK_LIST_MAX);
  assert.equal(ids.at(-1), luna.id);
  assert.deepEqual(ids.slice(0, 4), [opus.id, sonnet.id, sol.id, flash.id]);
});

test("stage one drops what this surface cannot pick", () => {
  const ids = quickListModels({
    models: [opus, model(sol.id, { comingSoon: true }), flash],
    favorites: [sol.id, "retired:model", AUTO_MODEL_ID],
    recent: [flash.id, opus.id],
    currentId: null,
    filter: (m) => m.provider !== "anthropic",
  }).map((m) => m.id);
  assert.deepEqual(ids, [flash.id]);
});

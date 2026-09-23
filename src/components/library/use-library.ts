"use client";

import * as React from "react";
import { toast } from "sonner";
import type { ClientAttachment } from "@/types/chat";
import {
  insertSorted,
  matchesView,
  type LibraryCounts,
  type LibraryItem,
  type LibraryKind,
  type LibrarySort,
  type LibraryStorage,
} from "@/components/library/library-types";

/** What the page is asking the Library for. */
export interface LibraryQuery {
  /** Already debounced by the caller; the raw field value would fetch per keystroke. */
  q: string;
  kind: LibraryKind;
  sort: LibrarySort;
  /** The Recently deleted view. */
  deleted: boolean;
}

/** Rows per request. The next page loads as the list's end scrolls into view. */
const PAGE_SIZE = 60;

/** How long "Moved to Recently deleted" offers Undo. */
const UNDO_MS = 6000;

interface LibraryResponse {
  items?: LibraryItem[];
  nextCursor?: string | null;
  counts?: LibraryCounts;
  total?: number;
  storage?: LibraryStorage;
}

function requestUrl(query: LibraryQuery, cursor?: string) {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), sort: query.sort });
  const q = query.q.trim();
  if (q) params.set("q", q);
  if (query.kind !== "all") params.set("kind", query.kind);
  if (query.deleted) params.set("includeDeleted", "true");
  if (cursor) params.set("cursor", cursor);
  return `/api/library?${params.toString()}`;
}

/** The fields a finished upload is missing to be a Library row, filled with what a new file has. */
function itemFromUpload(attachment: ClientAttachment): LibraryItem {
  return {
    id: attachment.id,
    kind: attachment.kind,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    size: attachment.size,
    url: attachment.url,
    createdAt: new Date().toISOString(),
    conversationId: null,
    version: 1,
    versionCount: 1,
    origin: "upload",
    parserState: attachment.parserState ?? "queued",
    parserVersion: null,
    deletedAt: null,
    // Indexing has not started yet and may never (an image), so the row says
    // nothing rather than guess; the next load reports what really happened.
    knowledge: null,
  };
}

/**
 * Runs one request per target and sorts the targets by outcome. `done` says
 * which responses count as success; by default, any 2xx.
 */
async function settleEach<T>(
  targets: T[],
  run: (target: T) => Promise<Response>,
  done: (response: Response) => boolean = (response) => response.ok,
) {
  const results = await Promise.allSettled(
    targets.map(async (target) => {
      const response = await run(target);
      if (!done(response)) throw new Error(String(response.status));
      return target;
    }),
  );
  const ok: T[] = [];
  const failed: T[] = [];
  results.forEach((result, index) => (result.status === "fulfilled" ? ok : failed).push(targets[index]));
  return { ok, failed };
}

/** Which list a row lives in on the server. */
type LibraryHome = "library" | "deleted";

/**
 * The Library's data and every change to it.
 *
 * Changes are OPTIMISTIC: a delete takes the row away in the frame it was
 * asked for and offers Undo, because a Library delete is a soft delete with a
 * restore endpoint behind it, and asking "are you sure?" about something that
 * can be undone is a question the product could answer itself. A failure puts
 * the row back where it was and says so.
 */
export function useLibrary(query: LibraryQuery) {
  const [items, setItems] = React.useState<LibraryItem[] | null>(null);
  const [counts, setCounts] = React.useState<LibraryCounts | null>(null);
  const [total, setTotal] = React.useState<number | null>(null);
  const [storage, setStorage] = React.useState<LibraryStorage | null>(null);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [error, setError] = React.useState(false);
  /** A new query is in flight while the previous answer stays on screen. */
  const [pending, setPending] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);

  // The latest query, for callbacks that outlive the render they were made in
  // (an Undo pressed after the reader has searched for something else).
  const queryRef = React.useRef(query);
  queryRef.current = query;
  // The rows on screen, for the same callbacks: whether a row is already in
  // the list decides whether putting it back or taking it out moves a count.
  const itemsRef = React.useRef(items);
  itemsRef.current = items;
  /** Bumped per request, so an answer to a query nobody is asking any more is dropped. */
  const generation = React.useRef(0);
  /**
   * The next page's cursor and the request whose answer it came from. A
   * cursor is a position in ONE query's order: once a new query is out, the
   * cursor on hand belongs to the list being replaced, and "Load more" sent
   * with it would append a page of the new query from the old one's position.
   */
  const cursor = React.useRef<{ value: string | null; generation: number }>({ value: null, generation: 0 });
  const loadingMoreRef = React.useRef(false);
  const controller = React.useRef<AbortController | null>(null);
  const lastDeletedView = React.useRef(query.deleted);

  const { q, kind, sort, deleted } = query;

  const setCursor = React.useCallback((value: string | null, from: number) => {
    cursor.current = { value, generation: from };
    setNextCursor(value);
  }, []);

  const reload = React.useCallback(async () => {
    const id = ++generation.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    // Switching between the library and Recently deleted is a different list,
    // not a refinement of this one: back to the skeleton rather than showing
    // one view's rows under the other's heading.
    if (lastDeletedView.current !== deleted) {
      lastDeletedView.current = deleted;
      setItems(null);
    }
    setPending(true);
    setError(false);
    try {
      const response = await fetch(requestUrl({ q, kind, sort, deleted }), { signal: abort.signal });
      if (!response.ok) throw new Error(String(response.status));
      const data = (await response.json()) as LibraryResponse;
      if (id !== generation.current) return;
      setItems(data.items ?? []);
      setCursor(data.nextCursor ?? null, id);
      setCounts(data.counts ?? null);
      setTotal(data.total ?? null);
      if (data.storage) setStorage(data.storage);
    } catch {
      if (abort.signal.aborted || id !== generation.current) return;
      setError(true);
    } finally {
      if (id === generation.current) setPending(false);
    }
  }, [q, kind, sort, deleted, setCursor]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  React.useEffect(() => () => controller.current?.abort(), []);

  const loadMore = React.useCallback(async () => {
    const { value, generation: from } = cursor.current;
    // A ref, not the `loadingMore` state: the scroll sentinel and the button
    // can both ask in the same frame, before a re-render would say so.
    if (!value || loadingMoreRef.current || from !== generation.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const response = await fetch(requestUrl(queryRef.current, value));
      if (!response.ok) throw new Error(String(response.status));
      const data = (await response.json()) as LibraryResponse;
      if (from !== generation.current) return;
      setItems((previous) => {
        const seen = new Set((previous ?? []).map((item) => item.id));
        return [...(previous ?? []), ...(data.items ?? []).filter((item) => !seen.has(item.id))];
      });
      setCursor(data.nextCursor ?? null, from);
    } catch {
      if (from === generation.current) toast.error("Couldn’t load more files.");
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [setCursor]);

  /** Counts follow the rows: the segmented control must never disagree with the list. */
  const adjustCounts = React.useCallback((rows: LibraryItem[], sign: 1 | -1) => {
    if (rows.length === 0) return;
    const current = queryRef.current;
    setTotal((value) => (value == null ? value : Math.max(0, value + sign * rows.length)));
    const hits = rows.filter((row) => matchesView(row, { q: current.q, kind: "all" }));
    if (hits.length === 0) return;
    setCounts((value) =>
      value
        ? {
            all: Math.max(0, value.all + sign * hits.length),
            IMAGE: Math.max(0, value.IMAGE + sign * hits.filter((row) => row.kind === "IMAGE").length),
            FILE: Math.max(0, value.FILE + sign * hits.filter((row) => row.kind === "FILE").length),
          }
        : value,
    );
  }, []);

  /**
   * Take rows out of the list on screen. Only rows that are IN it move the
   * counts: a rollback for a row that never reached this view, or an Undo for
   * one this view's first page never held, has nothing to subtract.
   */
  const removeRows = React.useCallback(
    (rows: LibraryItem[]) => {
      const onScreen = new Set((itemsRef.current ?? []).map((item) => item.id));
      const present = rows.filter((row) => onScreen.has(row.id));
      if (present.length === 0) return;
      const ids = new Set(present.map((row) => row.id));
      setItems((previous) => previous?.filter((item) => !ids.has(item.id)) ?? previous);
      adjustCounts(present, -1);
    },
    [adjustCounts],
  );

  /**
   * Put rows into the list on screen. The counts move for every row that was
   * not already there, drawn or not: a row that sorts past the loaded pages is
   * still one more file in this view.
   */
  const insertRows = React.useCallback(
    (rows: LibraryItem[]) => {
      const current = queryRef.current;
      const onScreen = new Set((itemsRef.current ?? []).map((item) => item.id));
      adjustCounts(
        rows.filter((row) => !onScreen.has(row.id)),
        1,
      );
      const visible = rows.filter((row) => matchesView(row, current));
      if (visible.length === 0) return;
      setItems((previous) =>
        previous ? insertSorted(previous, visible, current.sort, cursor.current.value !== null) : previous,
      );
    },
    [adjustCounts],
  );

  /**
   * Rows now live in `home` on the server. Into the list if that is the view
   * on screen; out of it if the reader is looking at the other one, where
   * they may still be drawn (an Undo pressed from inside Recently deleted
   * must take the file out of that list, not leave it there restored).
   */
  const placeRows = React.useCallback(
    (rows: LibraryItem[], home: LibraryHome) => {
      if (rows.length === 0) return;
      if (queryRef.current.deleted === (home === "deleted")) insertRows(rows);
      else removeRows(rows);
    },
    [insertRows, removeRows],
  );

  /** Move files to Recently deleted, with Undo. */
  const deleteItems = React.useCallback(
    (targets: LibraryItem[]) => {
      if (targets.length === 0) return;
      removeRows(targets);
      const settled = settleEach(targets, (target) => fetch(`/api/attachments/${target.id}`, { method: "DELETE" }));

      // Undo waits for the deletes to land (they have almost always landed by
      // the time anyone reaches the button): a restore sent ahead of its
      // delete finds nothing to restore, and rows whose delete failed are
      // already back in the list.
      const undo = async () => {
        const { ok } = await settled;
        if (ok.length === 0) return;
        placeRows(ok, "library");
        // 404 is "no deleted file with that id": restored already, from
        // Recently deleted, while this Undo was still on offer. The file is
        // where the reader asked for it, so that is not a failure to report.
        const restored = await settleEach(
          ok,
          (target) => fetch(`/api/attachments/${target.id}/restore`, { method: "POST" }),
          (response) => response.ok || response.status === 404,
        );
        if (restored.failed.length) {
          placeRows(restored.failed, "deleted");
          toast.error("Couldn’t undo. The files are in Recently deleted.");
        }
      };

      const toastId = toast.message("Moved to Recently deleted", {
        duration: UNDO_MS,
        action: { label: "Undo", onClick: () => void undo() },
      });

      void settled.then(({ ok, failed }) => {
        if (failed.length === 0) return;
        placeRows(failed, "library");
        if (ok.length === 0) toast.dismiss(toastId);
        toast.error(failed.length === 1 ? "Couldn’t delete that file." : "Couldn’t delete some of those files.");
      });
    },
    [placeRows, removeRows],
  );

  /** Bring files back from Recently deleted. */
  const restoreItems = React.useCallback(
    async (targets: LibraryItem[]) => {
      if (targets.length === 0) return;
      removeRows(targets);
      const { ok, failed } = await settleEach(targets, (target) =>
        fetch(`/api/attachments/${target.id}/restore`, { method: "POST" }),
      );
      if (failed.length) {
        placeRows(failed, "deleted");
        toast.error(failed.length === 1 ? "Couldn’t restore that file." : "Couldn’t restore some of those files.");
      }
      // The row leaving this list is visible; where it went is not.
      if (ok.length) toast.success("Restored to your library");
    },
    [placeRows, removeRows],
  );

  /** Resolves true when the new name was saved. */
  const renameItem = React.useCallback(async (target: LibraryItem, name: string) => {
    try {
      const response = await fetch(`/api/attachments/${target.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: name }),
      });
      const data = (await response.json().catch(() => ({}))) as { fileName?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "");
      // No success toast: the new name is on the row the reader is looking at.
      setItems(
        (previous) =>
          previous?.map((item) => (item.id === target.id ? { ...item, fileName: data.fileName ?? name } : item)) ??
          previous,
      );
      return true;
    } catch (caught) {
      toast.error(caught instanceof Error && caught.message ? caught.message : "Couldn’t rename that file.");
      return false;
    }
  }, []);

  /**
   * A finished upload joins the list. Returns whether it is visible: a PDF
   * uploaded while the list is filtered to images is in the library but not on
   * screen, and the page tells the reader so.
   */
  const addUploaded = React.useCallback(
    (attachment: ClientAttachment) => {
      const item = itemFromUpload(attachment);
      setStorage((value) =>
        value
          ? {
              ...value,
              usedBytes: value.usedBytes + item.size,
              remainingBytes: Math.max(0, value.remainingBytes - item.size),
            }
          : value,
      );
      const current = queryRef.current;
      if (current.deleted) return false;
      insertRows([item]);
      return matchesView(item, current);
    },
    [insertRows],
  );

  return {
    items,
    counts,
    total,
    storage,
    hasMore: nextCursor !== null,
    error,
    pending,
    loadingMore,
    reload,
    loadMore,
    deleteItems,
    restoreItems,
    renameItem,
    addUploaded,
  };
}

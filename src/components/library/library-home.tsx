"use client";

import * as React from "react";
import Link from "next/link";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { useApp } from "@/components/app/app-provider";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { LayoutGrid, List, Loader2, Search, Trash2, Upload, X } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { FileVersionsDialog, RenameFileDialog } from "./library-dialogs";
import { LibraryDropOverlay, useFileDrop } from "./library-drop-zone";
import {
  EntryRow,
  EntryTile,
  LibraryRowHead,
  UploadTile,
  entryFromFile,
  entryFromMade,
  type FileActions,
  type LibraryEntry,
} from "./library-items";
import type { LibraryItem } from "./library-types";
import { useLibrary } from "./use-library";
import { useLibraryUploads } from "./use-library-uploads";
import type { LibraryMadeItem } from "@/lib/library-made";
import { PLANS } from "@/lib/plans";
import { ACCEPT_ATTRIBUTE } from "@/lib/uploads";
import { formatBytes } from "@/lib/utils";
import { FEATURE_NAMES, PRODUCT_NAME } from "@/lib/brand/names";

/*
 * The Library: one place for what Alevr made and the files you gave it
 * (PRODUCT_REFOUNDATION §10, design V3 Library scene, critique 1).
 *
 * One row of controls under the title: what to show as a quiet segmented
 * row, then search and the view, together. Items are their previews. The
 * page keeps every feature today's Library has: Upload (and drop anywhere on
 * the page), storage used, Recently deleted, list and grid, the way back to
 * the chat an item came from, and each file's problem in words. Selecting
 * many files at once, sorting by name or size and filtering images live in
 * the file manager (`?view=files`), one press away from the Files filter.
 */

type Show = "all" | "made" | "files";

const VIEW_STORAGE_KEY = "juno-library-home-view";
const SEARCH_DEBOUNCE_MS = 200;
const PAGE = 48;

interface MadePage {
  items: LibraryMadeItem[];
  nextCursor: string | null;
}

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** Everything Alevr made, page by page, newest first; one request in flight per query. */
function useMade(q: string, enabled: boolean) {
  const [items, setItems] = React.useState<LibraryMadeItem[] | null>(null);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [error, setError] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);
  const generation = React.useRef(0);
  const url = React.useCallback(
    (after?: string | null) => `/api/library/made?limit=${PAGE}&q=${encodeURIComponent(q)}${after ? `&cursor=${encodeURIComponent(after)}` : ""}`,
    [q],
  );
  React.useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const token = ++generation.current;
    setItems(null);
    setCursor(null);
    setError(false);
    fetch(url(), { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return (await response.json()) as MadePage;
      })
      .then((data) => {
        if (generation.current !== token) return;
        setItems(data.items);
        setCursor(data.nextCursor);
      })
      .catch(() => {
        if (!controller.signal.aborted && generation.current === token) setError(true);
      });
    return () => controller.abort();
  }, [url, enabled, reloadKey]);
  const loadMore = React.useCallback(async () => {
    if (!cursor || loadingMore) return;
    const token = generation.current;
    setLoadingMore(true);
    try {
      const response = await fetch(url(cursor), { cache: "no-store" });
      if (!response.ok) throw new Error();
      const data = (await response.json()) as MadePage;
      if (token !== generation.current) return;
      setItems((current) => [...new Map([...(current ?? []), ...data.items].map((item) => [`${item.kind}:${item.id}`, item])).values()]);
      setCursor(data.nextCursor);
    } catch {
      if (token === generation.current) setError(true);
    } finally {
      if (token === generation.current) setLoadingMore(false);
    }
  }, [cursor, loadingMore, url]);
  const reload = React.useCallback(() => setReloadKey((key) => key + 1), []);
  return { items, hasMore: cursor !== null, error, loadingMore, loadMore, reload };
}

/** How many things wait in Recently deleted: files and made things, read once. */
function useDeletedCount() {
  const [count, setCount] = React.useState<number | null>(null);
  React.useEffect(() => {
    const controller = new AbortController();
    const read = <T,>(url: string) =>
      fetch(url, { signal: controller.signal, cache: "no-store" }).then((response) => (response.ok ? (response.json() as Promise<T>) : Promise.reject(new Error())));
    Promise.all([read<{ total?: number }>("/api/library?includeDeleted=true&limit=1"), read<{ items?: unknown[] }>("/api/artifacts?deleted=1")])
      .then(([files, artifacts]) => {
        if (typeof files.total === "number" && Array.isArray(artifacts.items)) setCount(files.total + artifacts.items.length);
      })
      .catch(() => {
        /* The link still works; it just carries no number. */
      });
    return () => controller.abort();
  }, []);
  return count;
}

export function LibraryHome() {
  const { quota } = useApp();
  const [show, setShow] = React.useState<Show>("all");
  const [view, setView] = React.useState<"grid" | "list">("grid");
  const [query, setQuery] = React.useState("");
  const q = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS);
  const files = useLibrary({ q, kind: "all", sort: "newest", deleted: false });
  const made = useMade(q, show !== "files");
  const deletedCount = useDeletedCount();
  const [renameTarget, setRenameTarget] = React.useState<LibraryItem | null>(null);
  const [versionsTarget, setVersionsTarget] = React.useState<LibraryItem | null>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    try {
      const saved = window.localStorage.getItem(VIEW_STORAGE_KEY);
      if (saved === "grid" || saved === "list") setView(saved);
    } catch {
      /* Storage can be unavailable; the grid is the default. */
    }
    const params = new URLSearchParams(window.location.search);
    const wanted = params.get("show");
    if (wanted === "made" || wanted === "files") setShow(wanted);
    if (params.get("upload") === "1") fileInput.current?.click();
  }, []);
  const changeView = (next: "grid" | "list") => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      /* The choice still holds for this visit. */
    }
  };

  const { addUploaded } = files;
  const uploads = useLibraryUploads({
    maxBytes: PLANS[quota.plan].maxUploadMb * 1024 * 1024,
    onUploaded: React.useCallback((attachment) => void addUploaded(attachment), [addUploaded]),
  });
  const { dragging, handlers } = useFileDrop({ onFiles: uploads.add, enabled: true });

  const actions: FileActions = {
    onRename: setRenameTarget,
    onVersions: setVersionsTarget,
    onDelete: (item) => files.deleteItems([item]),
  };

  const entries: LibraryEntry[] = [
    ...(show !== "made" ? (files.items ?? []).map(entryFromFile) : []),
    ...(show !== "files" ? (made.items ?? []).map(entryFromMade) : []),
  ].sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key));

  const filesPending = show !== "made" && files.items === null && !files.error;
  const madePending = show !== "files" && made.items === null && !made.error;
  const pending = filesPending || madePending;
  const failed = (show !== "made" && files.error) || (show !== "files" && made.error);
  const hasMore = (show !== "made" && files.hasMore) || (show !== "files" && made.hasMore);
  const loadingMore = files.loadingMore || made.loadingMore;
  const pendingUploads = show === "made" ? [] : uploads.uploads;
  const empty = !pending && !failed && entries.length === 0 && pendingUploads.length === 0;

  const loadMoreRef = React.useRef<() => void>(() => {});
  loadMoreRef.current = () => {
    if (show !== "made" && files.hasMore) void files.loadMore();
    if (show !== "files" && made.hasMore) void made.loadMore();
  };

  // The next page as the end of the list comes into view; the button stays for keyboards.
  const sentinel = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore || loadingMore || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((seen) => {
      if (seen.some((entry) => entry.isIntersecting)) loadMoreRef.current();
    }, { rootMargin: "400px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, show, entries.length]);

  const count = !hasMore && !pending ? entries.length : null;
  const searching = query.trim() !== q || files.pending;

  return (
    <div className="relative h-full" {...handlers}>
      <AppPage measure="wide">
        <AppPageHeader heading={FEATURE_NAMES.library.label}
          lede={`What ${PRODUCT_NAME} made and the files you gave it, newest first.`}
          actions={
            <>
              <Button variant="ghost" size="sm" asChild className="font-normal text-muted-foreground hover:text-foreground">
                <Link href="/library?view=trash">
                  <Trash2 className="size-4" aria-hidden="true" />
                  Recently deleted
                  {deletedCount ? <span className="tabular-nums text-muted-foreground">{deletedCount}</span> : null}
                </Link>
              </Button>
              <Button variant="secondary" size="sm" onClick={() => fileInput.current?.click()}>
                <Upload className="size-4" aria-hidden="true" />
                Upload
              </Button>
            </>
          }
        />
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept={ACCEPT_ATTRIBUTE}
          onChange={(event) => {
            if (event.target.files?.length) {
              uploads.add(event.target.files);
              if (show === "made") setShow("all");
            }
            event.target.value = "";
          }}
        />

        {/* One row: what to show on the left; search and the view together on the right. */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <SegmentedControl
            value={show}
            onChange={setShow}
            ariaLabel="Show"
            columns="content"
            className="rounded-control p-0.5"
            optionClassName="h-7 rounded-md px-3 py-0 text-ui coarse:h-9"
            options={[
              { value: "all", label: "All" },
              { value: "made", label: FEATURE_NAMES.artifacts.label },
              { value: "files", label: "Files" },
            ]}
          />
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2 @[40rem]/page:flex-none">
            {show === "files" ? (
              <Button variant="ghost" size="sm" asChild className="hidden font-normal text-muted-foreground hover:text-foreground @[40rem]/page:inline-flex">
                <Link href="/library?view=files">Manage files</Link>
              </Button>
            ) : null}
            <label className="relative flex min-w-0 flex-1 items-center @[40rem]/page:w-56 @[40rem]/page:flex-none">
              {searching ? (
                <Loader2 className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground motion-safe:animate-spin" aria-hidden="true" />
              ) : (
                <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" aria-hidden="true" />
              )}
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setQuery("");
                }}
                placeholder="Search the library"
                aria-label="Search the library"
                className="h-8 w-full min-w-0 rounded-field border border-border bg-background pl-8 pr-8 text-ui text-foreground outline-none transition-[border-color,box-shadow] duration-fast ease-out-soft placeholder:text-muted-foreground focus-visible:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring/40 coarse:h-10 [&::-webkit-search-cancel-button]:hidden"
              />
              {query ? (
                <button type="button" onClick={() => setQuery("")} aria-label="Clear search" className="absolute right-1 grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              ) : null}
            </label>
            <SegmentedControl
              value={view}
              onChange={changeView}
              ariaLabel="View"
              labelHidden
              className="shrink-0 gap-0.5 rounded-control p-0.5"
              optionClassName="size-7 rounded-md coarse:size-9"
              options={[
                { value: "grid", label: "Grid", icon: <LayoutGrid className="size-4" /> },
                { value: "list", label: "List", icon: <List className="size-4" /> },
              ]}
            />
          </div>
        </div>

        {failed ? (
          <p role="alert" className="mb-6 flex flex-wrap items-center gap-2 text-ui text-muted-foreground">
            Some of your Library couldn’t load. Nothing was changed.
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                made.reload();
                void files.reload();
              }}
            >
              Try again
            </Button>
          </p>
        ) : null}

        {pending ? (
          <LibrarySkeleton view={view} />
        ) : empty ? (
          q ? (
            <EmptyState
              icon={Search}
              title={`Nothing called “${q}”`}
              description="Search looks at the names of your files and of what was made. Try a client, a month or a number."
              action={
                <Button variant="secondary" size="sm" onClick={() => setQuery("")}>
                  Clear search
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Upload}
              title={show === "files" ? "No files yet" : "Your Library starts here"}
              description={`Files you upload or share in chats, and the documents, decks and sites ${PRODUCT_NAME} makes, collect here. Drop files anywhere on this page to add them.`}
              action={
                <>
                  <Button size="sm" variant="secondary" onClick={() => fileInput.current?.click()}>
                    <Upload className="size-4" aria-hidden="true" />
                    Upload files
                  </Button>
                  <Button variant="ghost" size="sm" asChild className="text-muted-foreground">
                    <Link href="/chat">Start a chat</Link>
                  </Button>
                </>
              }
            />
          )
        ) : view === "grid" ? (
          <ul
            aria-label={FEATURE_NAMES.library.label}
            className="grid grid-cols-2 gap-x-3 gap-y-6 @[40rem]/page:grid-cols-[repeat(auto-fill,minmax(212px,1fr))] @[40rem]/page:gap-x-5 @[40rem]/page:gap-y-7"
          >
            {pendingUploads.map((upload) => (
              <li key={upload.localId} className="min-w-0">
                <UploadTile upload={upload} onRetry={() => uploads.retry(upload.localId)} onDismiss={() => uploads.dismiss(upload.localId)} />
              </li>
            ))}
            {entries.map((entry) => (
              <li key={entry.key} className="min-w-0 motion-safe:animate-fade-in">
                <EntryTile entry={entry} actions={actions} />
              </li>
            ))}
          </ul>
        ) : (
          <div role="table" aria-label={FEATURE_NAMES.library.label} className="-mx-2.5 flex flex-col">
            <LibraryRowHead />
            {pendingUploads.map((upload) => (
              <div key={upload.localId} role="row" className="flex min-h-[52px] items-center gap-3 px-2.5 text-caption text-muted-foreground">
                <span role="cell" className="min-w-0 flex-1 truncate text-ui text-foreground">
                  {upload.fileName}
                </span>
                <span role="cell" className="tabular-nums">
                  {upload.status === "failed" ? (upload.error ?? "Didn’t upload") : `Uploading, ${Math.round(upload.progress)}%`}
                </span>
              </div>
            ))}
            {entries.map((entry) => (
              <EntryRow key={entry.key} entry={entry} actions={actions} />
            ))}
          </div>
        )}

        {hasMore && !pending ? (
          <div ref={sentinel} className="mt-8 flex justify-center">
            <Button variant="ghost" size="sm" className="text-muted-foreground" loading={loadingMore} onClick={() => loadMoreRef.current()}>
              Load more
            </Button>
          </div>
        ) : null}

        {!pending && !empty ? (
          <p className="mt-10 text-caption tabular-nums text-muted-foreground">
            {count !== null ? `${count} ${count === 1 ? "item" : "items"}` : null}
            {count !== null && files.storage ? ", " : null}
            {files.storage ? `${formatBytes(files.storage.usedBytes)} of ${formatBytes(files.storage.quotaBytes)} used` : null}
          </p>
        ) : null}

        <RenameFileDialog item={renameTarget} onOpenChange={(open) => !open && setRenameTarget(null)} onRename={files.renameItem} />
        <FileVersionsDialog item={versionsTarget} onOpenChange={(open) => !open && setVersionsTarget(null)} onRestored={() => void files.reload()} />
      </AppPage>
      <LibraryDropOverlay open={dragging} />
    </div>
  );
}

function LibrarySkeleton({ view }: { view: "grid" | "list" }) {
  if (view === "list") {
    return (
      <div role="status" aria-label="Loading your Library" className="flex flex-col gap-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-10 w-full rounded-control" />
        ))}
      </div>
    );
  }
  return (
    <div role="status" aria-label="Loading your Library" className="grid grid-cols-2 gap-x-3 gap-y-6 @[40rem]/page:grid-cols-[repeat(auto-fill,minmax(212px,1fr))] @[40rem]/page:gap-x-5">
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <div key={i} className="flex flex-col gap-2.5">
          <Skeleton className="aspect-[4/3] w-full rounded-control" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ))}
    </div>
  );
}

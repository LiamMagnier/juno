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
import { cn, formatBytes } from "@/lib/utils";
import { FEATURE_NAMES, PRODUCT_NAME } from "@/lib/brand/names";
import { Pressable } from "@/components/ui/pressable";

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

type Show = "all" | "made" | "files" | "media";
type MediaKind = "all" | "image" | "video" | "audio";

/** Pictures, video and sound: what the Media filter holds and Files leaves out. */
function mediaKindOf(mimeType: string): Exclude<MediaKind, "all"> | null {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return null;
}

/** The toolbar's segmented shells: rounded-menu p-1 on a 1px hairline, one h-9 row. */
const SHELL = "h-9 gap-0.5 rounded-menu border-foreground/10 bg-transparent p-1 coarse:h-11 dark:border-white/10";
/**
 * Same-size tiles on fixed container steps, not auto-fill, so the count is
 * deliberate: 2 on a phone, 3 from 40rem (a 1024 window), 4 from 56rem (the
 * wide measure at 1280 and up). One gutter: 12px on a phone, 16px above.
 */
const GRID = "grid grid-cols-2 gap-3 @[40rem]/page:grid-cols-3 @[40rem]/page:gap-4 @[56rem]/page:grid-cols-4";

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
  const [mediaKind, setMediaKind] = React.useState<MediaKind>("all");
  /** Files and Media are both the uploaded files, split by type; neither shows made items. */
  const filesOnly = show === "files" || show === "media";
  const [view, setView] = React.useState<"grid" | "list">("grid");
  const [query, setQuery] = React.useState("");
  const q = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS);
  const files = useLibrary({ q, kind: "all", sort: "newest", deleted: false });
  const made = useMade(q, !filesOnly);
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
    if (wanted === "made" || wanted === "files" || wanted === "media") setShow(wanted);
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

  const visibleFiles = (files.items ?? []).filter((file) => {
    const kind = mediaKindOf(file.mimeType);
    if (show === "files") return kind === null;
    if (show === "media") return kind !== null && (mediaKind === "all" || kind === mediaKind);
    return true;
  });
  const entries: LibraryEntry[] = [
    ...(show !== "made" ? visibleFiles.map(entryFromFile) : []),
    ...(!filesOnly ? (made.items ?? []).map(entryFromMade) : []),
  ].sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key));

  const filesPending = show !== "made" && files.items === null && !files.error;
  const madePending = !filesOnly && made.items === null && !made.error;
  const pending = filesPending || madePending;
  const failed = (show !== "made" && files.error) || (!filesOnly && made.error);
  const hasMore = (show !== "made" && files.hasMore) || (!filesOnly && made.hasMore);
  const loadingMore = files.loadingMore || made.loadingMore;
  const pendingUploads = show === "made" ? [] : uploads.uploads;
  const empty = !pending && !failed && entries.length === 0 && pendingUploads.length === 0;

  const loadMoreRef = React.useRef<() => void>(() => {});
  loadMoreRef.current = () => {
    if (show !== "made" && files.hasMore) void files.loadMore();
    if (!filesOnly && made.hasMore) void made.loadMore();
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
          backdrop
          lede={`What ${PRODUCT_NAME} made and the files you gave it, newest first.`}
          actions={
            <>
              <Button variant="ghost" size="sm" asChild className="h-9 gap-2 border-foreground/10 px-3 font-normal text-muted-foreground hover:border-foreground/[0.16] hover:text-foreground active:scale-[0.97] coarse:h-11 dark:border-white/10 dark:hover:border-white/[0.16]">
                <Link href="/library?view=trash">
                  <Trash2 className="size-4" aria-hidden="true" />
                  Recently deleted
                  {deletedCount ? <span className="-mr-0.5 font-mono text-label leading-none tabular-nums text-muted-foreground/80">{deletedCount}</span> : null}
                </Link>
              </Button>
              <Button size="sm" onClick={() => fileInput.current?.click()} className="ml-0.5 h-9 gap-2 px-3.5 active:scale-[0.97] coarse:h-11">
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

        {/* One row, one height (h-9): what to show on the left; search and the
            view together on the right. Both segmented shells are the brief's
            `rounded-menu p-1` with a hairline, holding 28px keys, so the row's
            four controls share a top and bottom edge. Under 40rem search and the
            view take their own full-width line beneath the filter. */}
        <div className={cn("flex flex-wrap items-center justify-between gap-3", show === "media" ? "mb-3" : "mb-6")}>
          <SegmentedControl
            value={show}
            onChange={setShow}
            ariaLabel="Show"
            columns="content"
            className={SHELL}
            optionClassName="h-7 rounded-control px-3 py-0 text-ui coarse:h-9"
            options={[
              { value: "all", label: "All" },
              { value: "made", label: FEATURE_NAMES.artifacts.label },
              { value: "files", label: "Files" },
              { value: "media", label: "Media" },
            ]}
          />
          <div className="flex w-full min-w-0 items-center justify-end gap-2 @[40rem]/page:w-auto @[40rem]/page:flex-none">
            {show === "files" ? (
              <Button variant="ghost" size="sm" asChild className="hidden h-9 font-normal text-muted-foreground hover:text-foreground @[40rem]/page:inline-flex">
                <Link href="/library?view=files">Manage files</Link>
              </Button>
            ) : null}
            <label className="relative flex min-w-0 flex-1 items-center @[40rem]/page:w-64 @[40rem]/page:flex-none">
              {searching ? (
                <Loader2 className="pointer-events-none absolute left-3 size-4 text-muted-foreground motion-safe:animate-spin" aria-hidden="true" />
              ) : (
                <Search className="pointer-events-none absolute left-3 size-4 text-muted-foreground" aria-hidden="true" />
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
                className="h-9 w-full min-w-0 rounded-field border border-foreground/10 bg-transparent pl-9 pr-9 text-ui text-foreground outline-none transition-[border-color,background-color,box-shadow] duration-fast ease-out-soft placeholder:text-muted-foreground hover:border-foreground/[0.16] focus-visible:border-foreground/25 focus-visible:bg-background focus-visible:ring-4 focus-visible:ring-foreground/[0.05] coarse:h-11 dark:border-white/10 dark:hover:border-white/[0.16] dark:focus-visible:border-white/25 [&::-webkit-search-cancel-button]:hidden"
              />
              {query ? (
                <button type="button" onClick={() => setQuery("")} aria-label="Clear search" className="absolute right-1.5 grid size-6 place-items-center rounded-control text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-foreground/[0.06] hover:text-foreground active:scale-90">
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              ) : null}
            </label>
            <SegmentedControl
              value={view}
              onChange={changeView}
              ariaLabel="View"
              labelHidden
              className={`${SHELL} shrink-0`}
              optionClassName="size-7 rounded-control coarse:size-9"
              options={[
                { value: "grid", label: "Grid", icon: <LayoutGrid className="size-4" /> },
                { value: "list", label: "List", icon: <List className="size-4" /> },
              ]}
            />
          </div>
        </div>

        {show === "media" ? (
          <div role="group" aria-label="Media type" className="mb-6 flex flex-wrap gap-2 motion-safe:animate-rise-in">
            {([
              ["all", "All media"],
              ["image", "Images"],
              ["video", "Videos"],
              ["audio", "Audio"],
            ] as const).map(([value, label]) => (
              <Pressable
                key={value}
                kind="chip"
                className="h-8 px-3 text-label coarse:h-10"
                selected={mediaKind === value}
                aria-pressed={mediaKind === value}
                onClick={() => setMediaKind(value)}
              >
                {label}
              </Pressable>
            ))}
          </div>
        ) : null}

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
          <div className="grid min-h-[min(48vh,28rem)] place-items-center">
          {q ? (
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
              title={show === "files" ? "No files yet" : show === "media" ? "No media yet" : "Your Library starts here"}
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
          )}
          </div>
        ) : view === "grid" ? (
          <ul
            aria-label={FEATURE_NAMES.library.label}
            className={GRID}
          >
            {pendingUploads.map((upload) => (
              <li key={upload.localId} className="min-w-0">
                <UploadTile upload={upload} onRetry={() => uploads.retry(upload.localId)} onDismiss={() => uploads.dismiss(upload.localId)} />
              </li>
            ))}
            {entries.map((entry, index) => (
              <li key={entry.key} className="min-w-0 motion-safe:animate-rise-in [animation-fill-mode:backwards]" style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}>
                <EntryTile entry={entry} actions={actions} />
              </li>
            ))}
          </ul>
        ) : (
          <div role="table" aria-label={FEATURE_NAMES.library.label} className="-mx-2.5 flex flex-col motion-safe:animate-rise-in">
            <LibraryRowHead />
            {pendingUploads.map((upload) => (
              <div key={upload.localId} role="row" className="flex h-12 items-center gap-3 rounded-control px-2.5 text-caption text-muted-foreground [&+*]:shadow-[0_-1px_0_hsl(var(--foreground)/0.07)]">
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
          <div ref={sentinel} className="mt-6 flex justify-center">
            <Button variant="ghost" size="sm" className="text-muted-foreground" loading={loadingMore} onClick={() => loadMoreRef.current()}>
              Load more
            </Button>
          </div>
        ) : null}

        {!pending && !empty ? (
          <p className="mt-6 border-t border-foreground/[0.07] pt-4 text-caption tabular-nums text-muted-foreground dark:border-white/[0.07]">
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
      <div role="status" aria-label="Loading your Library" className="flex flex-col">
        <div className="mb-1 h-9 border-b border-foreground/[0.07] dark:border-white/[0.07]" />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex h-12 items-center gap-3">
            <Skeleton className="size-8 shrink-0 rounded-control" />
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="ml-auto h-3 w-16" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div role="status" aria-label="Loading your Library" className={GRID}>
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <div key={i} className="surface-raised flex flex-col rounded-card p-1">
          {/* eslint-disable-next-line design-system/concentric-radius -- the rule's table is stale (card 16, control 10); tailwind.config.ts has card 12 and control 8, and 12 − 4 = 8 */}
          <Skeleton className="aspect-[4/3] w-full rounded-control" />
          <div className="flex flex-col gap-0.5 px-2 pb-2 pt-2.5">
            <span className="flex h-5 items-center"><Skeleton className="h-3.5 w-3/4" /></span>
            <span className="flex h-5 items-center"><Skeleton className="h-3 w-1/3" /></span>
          </div>
        </div>
      ))}
    </div>
  );
}

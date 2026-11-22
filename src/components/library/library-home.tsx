"use client";

import * as React from "react";
import Link from "next/link";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { useApp } from "@/components/app/app-provider";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { LayoutGrid, List, Search, Trash2, Upload } from "@/components/ui/icons";
import { LibraryNavigation } from "./library-navigation";
import { useWorkspaceHref } from "@/hooks/use-workspace-href";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { FileVersionsDialog, RenameFileDialog } from "./library-dialogs";
import { LibraryQuickLook } from "./library-quick-look";
import { LibraryArtifactInspector } from "./library-artifact-inspector";
import { useMediaQuery } from "@/hooks/use-media-query";
import { LibraryDropOverlay, useFileDrop } from "./library-drop-zone";
import {
  EntryRow,
  EntryTile,
  LibraryRowHead,
  UploadRow,
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
import { ARTIFACT_CHANGED_EVENT } from "@/lib/artifact-events";
import { PLANS } from "@/lib/plans";
import { ACCEPT_ATTRIBUTE } from "@/lib/uploads";
import { cn, formatBytes } from "@/lib/utils";
import { FEATURE_NAMES, PRODUCT_NAME } from "@/lib/brand/names";
import { Pressable } from "@/components/ui/pressable";
import { StatusIcons } from "@/lib/app-icons";
import { staggerDelay } from "@/lib/motion";

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

type MediaKind = "all" | "image" | "video" | "audio";

/** Pictures, video and sound: what the Media filter holds and Files leaves out. */
function mediaKindOf(mimeType: string): Exclude<MediaKind, "all"> | null {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return null;
}

/**
 * Same-size tiles on fixed container steps, not auto-fill, so the count is
 * deliberate: 2 on a phone, 3 from 40rem (a 1024 window), 4 from 56rem (the
 * wide measure at 1280 and up). One gutter: 12px on a phone, 16px above.
 */
const GRID = "ed-arrive grid grid-cols-2 gap-3 @[40rem]/page:grid-cols-3 @[40rem]/page:gap-4 @[56rem]/page:grid-cols-4";

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
  /** A new search (or a reload) is out while the last answer stays on screen. */
  const [pending, setPending] = React.useState(false);
  /** Whether what is on screen is an answer from this source at all (false before the first, and after it was switched off). */
  const shown = React.useRef(false);
  const generation = React.useRef(0);
  const url = React.useCallback(
    (after?: string | null) => `/api/library/made?limit=${PAGE}&q=${encodeURIComponent(q)}${after ? `&cursor=${encodeURIComponent(after)}` : ""}`,
    [q],
  );
  React.useEffect(() => {
    if (!enabled) {
      shown.current = false;
      return;
    }
    const controller = new AbortController();
    const token = ++generation.current;
    // A search typed over results keeps them on screen until the new answer
    // lands, as the file manager's search does: emptying the list here put
    // the whole grid back to its skeleton on every keystroke. Only a first
    // load (or a return to this source) starts from the placeholder.
    if (!shown.current) setItems(null);
    // No cursor while the new answer is out: "Load more" must not append a
    // page of the old search to the new one.
    setCursor(null);
    setError(false);
    setPending(true);
    fetch(url(), { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return (await response.json()) as MadePage;
      })
      .then((data) => {
        if (generation.current !== token) return;
        setItems(data.items);
        setCursor(data.nextCursor);
        shown.current = true;
      })
      .catch(() => {
        if (!controller.signal.aborted && generation.current === token) setError(true);
      })
      .finally(() => {
        if (generation.current === token) setPending(false);
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
  // A rename, copy or delete from an item's own menu (ArtifactLifecycleActions)
  // shows in this list without a reload of the page.
  React.useEffect(() => {
    if (!enabled) return;
    window.addEventListener(ARTIFACT_CHANGED_EVENT, reload);
    return () => window.removeEventListener(ARTIFACT_CHANGED_EVENT, reload);
  }, [enabled, reload]);
  return { items, hasMore: cursor !== null, error, pending, loadingMore, loadMore, reload };
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

export function LibraryHome({ mediaOnly = false }: { mediaOnly?: boolean }) {
  const { quota } = useApp();
  const hrefFor = useWorkspaceHref();
  const [mediaKind, setMediaKind] = React.useState<MediaKind>("all");
  const [view, setView] = React.useState<"grid" | "list">("grid");
  const [query, setQuery] = React.useState("");
  const q = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS);
  const files = useLibrary({ q, kind: "all", sort: "newest", deleted: false });
  const made = useMade(q, !mediaOnly);
  const deletedCount = useDeletedCount();
  const [renameTarget, setRenameTarget] = React.useState<LibraryItem | null>(null);
  const [versionsTarget, setVersionsTarget] = React.useState<LibraryItem | null>(null);
  const [previewTarget, setPreviewTarget] = React.useState<LibraryItem | null>(null);
  const [inspected, setInspected] = React.useState<LibraryEntry | null>(null);
  const inspectOpener = React.useRef<HTMLAnchorElement | null>(null);
  const inlineInspector = useMediaQuery("(min-width: 72rem)");
  const closeInspector = () => {
    setInspected(null);
    window.requestAnimationFrame(() => inspectOpener.current?.focus({ preventScroll: true }));
  };
  const fileInput = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    try {
      const saved = window.localStorage.getItem(VIEW_STORAGE_KEY);
      if (saved === "grid" || saved === "list") setView(saved);
    } catch {
      /* Storage can be unavailable; the grid is the default. */
    }
    const params = new URLSearchParams(window.location.search);
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
  /** The plan's per-file limit: the constant /api/upload enforces, so the page can state it exactly. */
  const limitMb = PLANS[quota.plan].maxUploadMb;
  const uploads = useLibraryUploads({
    maxBytes: limitMb * 1024 * 1024,
    onUploaded: React.useCallback((attachment) => void addUploaded(attachment), [addUploaded]),
  });
  const { dragging, handlers } = useFileDrop({ onFiles: uploads.add, enabled: true });

  const actions: FileActions = {
    onRename: setRenameTarget,
    onVersions: setVersionsTarget,
    onDelete: (item) => files.deleteItems([item]),
    onPreview: setPreviewTarget,
    inspectedKey: inspected?.key,
    onInspectArtifact: (entry, opener) => {
      inspectOpener.current = opener;
      setInspected(entry);
    },
  };

  const visibleFiles = (files.items ?? []).filter((file) => {
    const kind = mediaKindOf(file.mimeType);
    if (mediaOnly) return kind !== null && (mediaKind === "all" || kind === mediaKind);
    return true;
  });
  const entries: LibraryEntry[] = [
    ...visibleFiles.map(entryFromFile),
    ...(!mediaOnly ? (made.items ?? []).map(entryFromMade) : []),
  ].sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key));

  const filesPending = files.items === null && !files.error;
  const madePending = !mediaOnly && made.items === null && !made.error;
  const pending = filesPending || madePending;
  const failed = files.error || (!mediaOnly && made.error);
  const hasMore = files.hasMore || (!mediaOnly && made.hasMore);
  const loadingMore = files.loadingMore || made.loadingMore;
  const pendingUploads = uploads.uploads;
  const empty = !pending && !failed && entries.length === 0 && pendingUploads.length === 0;
  /** Nothing could be shown at all: the page's error state, not a sentence over an empty page. */
  const failedOutright = failed && !pending && entries.length === 0 && pendingUploads.length === 0;

  const loadMoreRef = React.useRef<() => void>(() => {});
  loadMoreRef.current = () => {
    if (files.hasMore) void files.loadMore();
    if (!mediaOnly && made.hasMore) void made.loadMore();
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
  }, [hasMore, loadingMore, mediaOnly, entries.length]);

  // No count while part of the Library failed to load: "0 items" over a
  // failure read as an empty Library.
  const count = !hasMore && !pending && !failed ? entries.length : null;
  const searching = query.trim() !== q || files.pending || (!mediaOnly && made.pending);

  return (
    <div className="relative h-full" {...handlers}>
      <AppPage measure="wide">
        <AppPageHeader heading={mediaOnly ? "Media" : FEATURE_NAMES.library.label}
          lede={mediaOnly ? undefined : "Find files, designs, and work you’ve created."}
          actions={
            <>
              {/* bg-background: the header's drawing (backdrop) runs behind this
                  corner, and a transparent button let it show through its words. */}
              <Button variant="ghost" asChild className="gap-2 border-foreground/10 bg-background px-3 font-normal coarse:min-w-11 text-muted-foreground hover:border-foreground/[0.16] hover:text-foreground active:scale-[0.97] dark:border-white/10 dark:hover:border-white/[0.16]">
                <Link href={hrefFor("/library?view=trash")}>
                  <Trash2 className="size-4" aria-hidden="true" />
                  {/* A glyph and its count on a phone (G54), so both actions
                      share the title's line; the name stays for a screen reader. */}
                  <span className="sr-only @[40rem]/page:not-sr-only">Recently deleted</span>
                  {deletedCount ? <span className="-mr-0.5 text-label leading-none tabular-nums text-muted-foreground">{deletedCount}</span> : null}
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
            }
            event.target.value = "";
          }}
        />

        <LibraryNavigation active={mediaOnly ? "media" : "all"} />
        <div className="mb-4 flex items-center justify-end gap-2">
            <SearchField
              value={query}
              onValueChange={setQuery}
              label="Search the library"
              busy={searching}
              className="min-w-0 @[40rem]/page:w-64 @[40rem]/page:flex-none"
            />
            <SegmentedControl
              value={view}
              onChange={changeView}
              ariaLabel="View"
              labelHidden
              className="shrink-0"
              options={[
                { value: "grid", label: "Grid", icon: <LayoutGrid className="size-4" /> },
                { value: "list", label: "List", icon: <List className="size-4" /> },
              ]}
            />
        </div>

        {mediaOnly ? (
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

        {failed && !failedOutright ? (
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

        <div className={cn("grid min-w-0 gap-6", inspected && inlineInspector && "grid-cols-[minmax(0,1fr)_minmax(17rem,22rem)] items-start")}>
          <div className="min-w-0 @container/library">
            {pending ? (
              <LibrarySkeleton view={view} />
            ) : failedOutright ? (
              <div className="grid min-h-[min(48vh,28rem)] place-items-center">
                <EmptyState
                  tone="error"
                  icon={StatusIcons.error}
                  title="Your Library didn’t load"
                  description="Nothing was changed. Check your connection and try again."
                  action={
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
                  }
                />
              </div>
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
                  title={mediaOnly ? "No media yet" : "Your Library starts here"}
                  description={`Files you upload or share in chats, and the documents, decks and sites ${PRODUCT_NAME} makes, collect here. Drop files anywhere on this page to add them, up to ${limitMb} MB each.`}
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
                className={cn(GRID, inspected && inlineInspector && "@[40rem]/page:grid-cols-2 @[56rem]/page:grid-cols-2")}
              >
                {pendingUploads.map((upload) => (
                  <li key={upload.localId} className="min-w-0">
                    <UploadTile upload={upload} onRetry={() => uploads.retry(upload.localId)} onDismiss={() => uploads.dismiss(upload.localId)} />
                  </li>
                ))}
                {entries.map((entry, index) => (
                  <li key={entry.key} className="min-w-0 motion-safe:animate-rise-in [animation-fill-mode:backwards]" style={staggerDelay(index, "tight")}>
                    <EntryTile entry={entry} actions={actions} />
                  </li>
                ))}
              </ul>
            ) : (
              <div role="table" aria-label={FEATURE_NAMES.library.label} className="-mx-2.5 flex flex-col">
                <LibraryRowHead />
                {pendingUploads.map((upload) => (
                  <UploadRow key={upload.localId} upload={upload} onRetry={() => uploads.retry(upload.localId)} onDismiss={() => uploads.dismiss(upload.localId)} />
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

            {!pending && !empty && !failedOutright && (count !== null || files.storage) ? (
              <p className="mt-6 border-t border-foreground/[0.07] pt-4 text-caption tabular-nums text-muted-foreground dark:border-white/[0.07]">
                {count !== null ? `${count} ${count === 1 ? "item" : "items"}` : null}
                {count !== null && files.storage ? ", " : null}
                {files.storage ? `${formatBytes(files.storage.usedBytes)} of ${formatBytes(files.storage.quotaBytes)} used` : null}
              </p>
            ) : null}

          </div>
          {inspected && (
            <LibraryArtifactInspector key={inspected.key} entry={inspected} inline={inlineInspector} onClose={closeInspector} />
          )}
        </div>

        <RenameFileDialog item={renameTarget} onOpenChange={(open) => !open && setRenameTarget(null)} onRename={files.renameItem} />
        <FileVersionsDialog item={versionsTarget} onOpenChange={(open) => !open && setVersionsTarget(null)} onRestored={() => void files.reload()} />
        <LibraryQuickLook item={previewTarget} onOpenChange={(open) => !open && setPreviewTarget(null)} />
      </AppPage>
      <LibraryDropOverlay open={dragging} limitMb={limitMb} />
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
        <div key={i} className="nest-card nest-p-1 flex flex-col border border-border/70 bg-card p-1">
          {/* 12 − 4 = 8: concentric inside the p-1 card. */}
          <Skeleton className="aspect-[4/3] w-full rounded-inner" />
          <div className="flex flex-col gap-0.5 px-2 pb-2 pt-2.5">
            <span className="flex h-5 items-center"><Skeleton className="h-3.5 w-3/4" /></span>
            <span className="flex h-5 items-center"><Skeleton className="h-3 w-1/3" /></span>
          </div>
        </div>
      ))}
    </div>
  );
}

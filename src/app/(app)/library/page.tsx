"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft, Search, Upload } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/ui/empty-state";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { useApp } from "@/components/app/app-provider";
import { LibraryBrowserSkeleton, LibraryGrid, LibraryList } from "@/components/library/library-browser";
import { FileVersionsDialog, RenameFileDialog } from "@/components/library/library-dialogs";
import { LibraryDropOverlay, useFileDrop } from "@/components/library/library-drop-zone";
import { LibraryStorageCaption, LibraryToolbar, LibraryToolbarSkeleton } from "@/components/library/library-toolbar";
import type { LibraryItem, LibraryKind, LibrarySort, LibraryView } from "@/components/library/library-types";
import { useLibrary } from "@/components/library/use-library";
import { useLibraryUploads } from "@/components/library/use-library-uploads";
import { ActionIcons, AppIcons, StatusIcons } from "@/lib/app-icons";
import { PLANS } from "@/lib/plans";
import { ACCEPT_ATTRIBUTE } from "@/lib/uploads";

const LIBRARY_VIEW_STORAGE_KEY = "juno-library-view";

/** Long enough to let a word finish, short enough to feel like it answered the typing. */
const SEARCH_DEBOUNCE_MS = 200;

/** How long the first page's rows take to be dealt out; after it, rows simply appear. */
const REVEAL_MS = 600;

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * /library: every file and image the reader has uploaded or shared in chat.
 *
 * The page is the composition; the parts live in `components/library`, where
 * the list, the dialogs and the drop overlay are presentational and the two
 * hooks own the data (`useLibrary`) and the uploads (`useLibraryUploads`).
 * That split is also what lets `/dev/library` draw every state of this page
 * from fixtures.
 */
export default function LibraryPage() {
  const { quota } = useApp();
  const [query, setQuery] = React.useState("");
  const q = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS);
  const [kind, setKind] = React.useState<LibraryKind>("all");
  const [sort, setSort] = React.useState<LibrarySort>("newest");
  const [view, setView] = React.useState<LibraryView>("list");
  const [deletedView, setDeletedView] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const [renameTarget, setRenameTarget] = React.useState<LibraryItem | null>(null);
  const [versionsTarget, setVersionsTarget] = React.useState<LibraryItem | null>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);

  const library = useLibrary({ q, kind, sort, deleted: deletedView });

  const clearFilters = React.useCallback(() => {
    setQuery("");
    setKind("all");
  }, []);

  const maxBytes = PLANS[quota.plan].maxUploadMb * 1024 * 1024;
  const { addUploaded } = library;
  const uploads = useLibraryUploads({
    maxBytes,
    onUploaded: React.useCallback(
      (attachment) => {
        if (addUploaded(attachment)) return;
        // In the library, but not in the list on screen: say where it went
        // instead of letting a successful upload look like a lost one.
        toast.message("Uploaded. Your filters are hiding it.", {
          action: {
            label: "Show",
            onClick: () => {
              setDeletedView(false);
              clearFilters();
            },
          },
        });
      },
      [addUploaded, clearFilters],
    ),
  });

  const { dragging, handlers } = useFileDrop({ onFiles: uploads.add, enabled: !deletedView });

  // Deal the first page out; after that rows appear as they arrive. A search
  // result replacing another is a swap, not a reveal.
  const [revealed, setRevealed] = React.useState(false);
  React.useEffect(() => {
    if (library.items === null) {
      setRevealed(false);
      return;
    }
    if (revealed) return;
    const timer = window.setTimeout(() => setRevealed(true), REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, [library.items, revealed]);

  React.useEffect(() => {
    try {
      const saved = window.localStorage.getItem(LIBRARY_VIEW_STORAGE_KEY);
      if (saved === "list" || saved === "grid") setView(saved);
    } catch {
      // Storage can be unavailable in hardened browsing modes; list remains the safe default.
    }
  }, []);

  const changeView = (next: LibraryView) => {
    setView(next);
    try {
      window.localStorage.setItem(LIBRARY_VIEW_STORAGE_KEY, next);
    } catch {
      // The in-memory preference still works when local storage is unavailable.
    }
  };

  const switchView = (deleted: boolean) => {
    setSelected(new Set());
    setDeletedView(deleted);
  };

  // Loading more as the end of the list comes into view. The button under it
  // stays as the fallback, and as the thing a keyboard reaches.
  const sentinel = React.useRef<HTMLDivElement>(null);
  const { hasMore, loadMore } = library;
  React.useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  const items = library.items ?? [];
  const pendingUploads = deletedView ? [] : uploads.uploads;
  const loading = library.items === null && !library.error;
  const filtered = q.length > 0 || kind !== "all";
  const libraryEmpty = !loading && library.total === 0 && pendingUploads.length === 0;
  const noResults = !loading && !libraryEmpty && items.length === 0 && pendingUploads.length === 0;

  const selectedItems = items.filter((item) => selected.has(item.id));
  const allSelected = items.length > 0 && items.every((item) => selected.has(item.id));

  // Rows that left the list (deleted, restored, filtered away) leave the selection too.
  React.useEffect(() => {
    if (!library.items) return;
    setSelected((previous) => {
      if (previous.size === 0) return previous;
      const present = new Set(library.items?.map((item) => item.id));
      const next = new Set([...previous].filter((id) => present.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [library.items]);

  const toggleSelect = (id: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleSelectAll = () => setSelected(allSelected ? new Set() : new Set(items.map((item) => item.id)));

  const browserProps = {
    items,
    uploads: pendingUploads,
    selected,
    deletedView,
    stagger: !revealed,
    onToggleSelect: toggleSelect,
    onRename: setRenameTarget,
    onDelete: (item: LibraryItem) => library.deleteItems([item]),
    onRestore: (item: LibraryItem) => void library.restoreItems([item]),
    onVersions: setVersionsTarget,
    onRetryUpload: uploads.retry,
    onDismissUpload: uploads.dismiss,
  };

  const openPicker = () => fileInput.current?.click();

  return (
    // The drop zone is the whole content column, and the overlay is pinned to
    // it rather than to the scrolling page, so it covers what is on screen
    // however far down the list the reader is.
    <div className="relative h-full" {...handlers}>
      <AppPage measure="wide">
        <AppPageHeader
          // Recently deleted is a MODE, not a filter, so it has to be legible
          // in the heading.
          heading={deletedView ? "Recently deleted" : "Files"}
          lede={deletedView ? "Files you delete land here and can be restored." : "Everything you upload or share in chats."}
          actions={
            deletedView ? (
              <Button variant="secondary" size="sm" onClick={() => switchView(false)}>
                <ArrowLeft className="size-3.5" />
                Back to files
              </Button>
            ) : (
              <>
                {library.storage && !libraryEmpty && (
                  <LibraryStorageCaption storage={library.storage} className="hidden @[40rem]/page:block" />
                )}
                <Button variant="secondary" size="sm" onClick={() => switchView(true)}>
                  <ActionIcons.delete className="size-3.5" />
                  Recently deleted
                </Button>
                <Button size="sm" onClick={openPicker}>
                  <Upload className="size-3.5" />
                  Upload
                </Button>
              </>
            )
          }
        />

        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept={ACCEPT_ATTRIBUTE}
          onChange={(event) => {
            if (event.target.files?.length) uploads.add(event.target.files);
            // Cleared so choosing the same file again still fires a change.
            event.target.value = "";
          }}
        />

        {/* Only once there is something to filter: six controls acting on a
            list that does not exist would state the emptiness three more
            times above the empty state. A search that matched nothing keeps
            its toolbar, because the reader needs the box to clear it. */}
        {loading ? (
          <LibraryToolbarSkeleton />
        ) : (
          !library.error &&
          !libraryEmpty && (
            <LibraryToolbar
              query={query}
              onQueryChange={setQuery}
              // From the first keystroke, not only once the request leaves:
              // the debounce is part of the wait.
              searching={library.pending || query.trim() !== q}
              kind={kind}
              onKindChange={setKind}
              counts={library.counts}
              sort={sort}
              onSortChange={setSort}
              view={view}
              onViewChange={changeView}
              selectToggle={view === "grid" && items.length > 0 ? { allSelected, onToggle: toggleSelectAll } : undefined}
            />
          )
        )}

        <div className="mt-5">
          {library.error ? (
            <EmptyState
              tone="error"
              icon={StatusIcons.error}
              title="Couldn’t load your files"
              description="Check your connection and try again."
              action={
                <Button variant="secondary" size="sm" onClick={() => void library.reload()}>
                  <ActionIcons.refresh className="size-4" aria-hidden="true" />
                  Try again
                </Button>
              }
            />
          ) : loading ? (
            <LibraryBrowserSkeleton view={view} />
          ) : libraryEmpty && deletedView ? (
            <EmptyState
              icon={ActionIcons.delete}
              title="Nothing in Recently deleted"
              action={
                <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => switchView(false)}>
                  Back to files
                </Button>
              }
            />
          ) : libraryEmpty ? (
            <EmptyState
              icon={AppIcons.library}
              title="No files yet"
              description="Upload files here, or drop them anywhere on this page. Files you share in chats are kept here too."
              action={
                <>
                  <Button size="sm" onClick={openPicker}>
                    <Upload className="size-3.5" />
                    Upload files
                  </Button>
                  <Button variant="ghost" size="sm" asChild className="text-muted-foreground">
                    <Link href="/chat">Go to chat</Link>
                  </Button>
                </>
              }
            />
          ) : noResults ? (
            <EmptyState
              size="panel"
              icon={Search}
              title="No matching files"
              description={filtered ? "Try another name, or clear the filter." : undefined}
              action={
                <Button variant="ghost" size="sm" onClick={clearFilters} className="text-muted-foreground">
                  Clear filters
                </Button>
              }
            />
          ) : view === "grid" ? (
            <LibraryGrid {...browserProps} />
          ) : (
            <LibraryList {...browserProps} onToggleAll={toggleSelectAll} />
          )}
        </div>

        {library.hasMore && !loading && !library.error && (
          <div ref={sentinel} className="mt-5 flex justify-center">
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => void library.loadMore()} loading={library.loadingMore}>
              Load more
            </Button>
          </div>
        )}

        {selectedItems.length > 0 && (
          // The bulk bar floats at the bottom of the scroll region while the list
          // runs past it, and docks under the list when it does not.
          <div
            className="surface-float sticky bottom-4 z-toolbar mt-5 flex min-h-12 flex-wrap items-center gap-2 rounded-card py-2 pl-4 pr-2 motion-safe:animate-rise-in"
            aria-live="polite"
          >
            <span className="text-ui font-medium tabular-nums text-foreground">
              <span>{selectedItems.length}</span> selected
            </span>
            <div className="ml-auto flex items-center gap-1">
              {selectedItems.length === 1 && !deletedView && (
                <Button variant="ghost" size="sm" onClick={() => setRenameTarget(selectedItems[0])}>
                  <ActionIcons.edit className="size-3.5" />
                  Rename
                </Button>
              )}
              {deletedView ? (
                <Button variant="secondary" size="sm" onClick={() => void library.restoreItems(selectedItems)}>
                  <ActionIcons.restore className="size-3.5" />
                  Restore
                </Button>
              ) : (
                <Button variant="destructive-outline" size="sm" onClick={() => library.deleteItems(selectedItems)}>
                  <ActionIcons.delete className="size-3.5" />
                  Delete
                </Button>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={() => setSelected(new Set())} aria-label="Clear selection">
                    <ActionIcons.dismiss className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Clear selection</TooltipContent>
              </Tooltip>
            </div>
          </div>
        )}

        <RenameFileDialog
          item={renameTarget}
          onOpenChange={(open) => !open && setRenameTarget(null)}
          onRename={library.renameItem}
        />
        <FileVersionsDialog
          item={versionsTarget}
          onOpenChange={(open) => !open && setVersionsTarget(null)}
          onRestored={() => void library.reload()}
        />
      </AppPage>

      <LibraryDropOverlay open={dragging} />
    </div>
  );
}

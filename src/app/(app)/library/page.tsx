"use client";

import * as React from "react";
import { FilePreview } from "@/components/chat/file-preview";
import Link from "next/link";
import { toast } from "sonner";
import {
  History,
  LayoutGrid,
  List as ListIcon,
  MessageCircle,
  Minus,
  Search,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ActionIcons, AppIcons, StatusIcons } from "@/lib/app-icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { IndexStatus, type KnowledgeIndexState } from "@/components/library/index-status";
import { cn, formatBytes } from "@/lib/utils";
import { staggerDelay } from "@/lib/motion";
import { EmptyState } from "@/components/ui/empty-state";
import { AppPageHeader } from "@/components/app/app-page-header";
import { SegmentedControl } from "@/components/ui/segmented-control";

interface LibItem {
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
  /** Structured-extraction state, or null when no extractor claims the format. */
  knowledge?: (KnowledgeIndexState & { documentId?: string }) | null;
}

interface LibVersion {
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

type LibraryFilter = "all" | LibItem["kind"];
type LibraryView = "list" | "grid";

const LIBRARY_VIEW_STORAGE_KEY = "juno-library-view";

const TABS: { key: LibraryFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "IMAGE", label: "Images" },
  { key: "FILE", label: "Files" },
];

const browserGrid =
  "grid grid-cols-[2rem_minmax(0,1fr)_2.5rem] items-center gap-2 sm:grid-cols-[2rem_minmax(0,1fr)_5rem_6.5rem_6.75rem] sm:gap-3 md:grid-cols-[2rem_minmax(0,1fr)_5.5rem_5.5rem_7rem_6.75rem]";

function typeLabel(item: LibItem) {
  const extension = item.fileName.includes(".") ? item.fileName.split(".").pop()?.trim() : "";
  if (extension && extension.length <= 8) return extension.toUpperCase();
  return item.kind === "IMAGE" ? "Image" : "File";
}

function countFor(items: LibItem[], filter: LibraryFilter) {
  return filter === "all" ? items.length : items.filter((item) => item.kind === filter).length;
}

/** The two view modes, as the segmented control's options. */
const VIEW_OPTIONS = [
  { value: "list" as const, label: "List", icon: <ListIcon className="size-3.5" /> },
  { value: "grid" as const, label: "Grid", icon: <LayoutGrid className="size-3.5" /> },
];

function SelectCheck({
  checked,
  onClick,
  label,
  className,
}: {
  /** `"mixed"` for a select-all standing over a partially selected set. */
  checked: boolean | "mixed";
  onClick: () => void;
  label: string;
  className?: string;
}) {
  return (
    // role="checkbox" + aria-checked, not aria-pressed: this is a checkbox drawn
    // as a button, and "pressed/not pressed" is the wrong announcement for it.
    // aria-pressed also has no third value, so the select-all read identically at
    // 0 of 12 selected and at 3 of 12.
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      aria-label={label}
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-xs border transition-[border-color,background-color,color,transform] duration-fast ease-out-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-90 coarse:size-7",
        checked
          ? "border-foreground bg-foreground text-background"
          : "border-border/80 bg-background text-transparent hover:border-foreground/50",
        className
      )}
    >
      {checked === "mixed" ? (
        <Minus className="size-3.5" aria-hidden />
      ) : (
        <StatusIcons.success className="size-3.5" aria-hidden />
      )}
    </button>
  );
}

function ItemPreview({ item }: { item: LibItem }) {
  const preview = (
    <FilePreview item={item} className="absolute inset-0" sizes="44px" excerpt={false} />
  );
  const className = "group/preview relative size-11 shrink-0 overflow-hidden rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";
  return item.deletedAt ? (
    <div className={className} aria-label={`${item.fileName} is deleted`}>{preview}</div>
  ) : (
    <a href={item.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${item.fileName}`} className={className}>
      {preview}
    </a>
  );
}

function ItemAction({
  icon: Icon,
  label,
  onClick,
  tone,
  motion = "lift",
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  tone?: "danger";
  motion?: "lift" | "edit" | "delete";
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "group/action text-muted-foreground",
        tone === "danger" ? "danger-hover" : "hover:text-foreground"
      )}
    >
      <Icon
        className={cn(
          "size-4 transition-transform duration-fast ease-out-soft motion-reduce:transition-none",
          motion === "lift" && "group-hover/action:-translate-y-0.5",
          motion === "edit" && "group-hover/action:-translate-y-0.5 group-hover/action:-rotate-6",
          motion === "delete" && "origin-bottom group-hover/action:rotate-6"
        )}
      />
    </Button>
  );
}

function DownloadAction({ item }: { item: LibItem }) {
  if (item.deletedAt) return null;
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      asChild
      className="group/action text-muted-foreground hover:text-foreground"
    >
      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        download={item.fileName}
        aria-label={`Download ${item.fileName}`}
        title="Download"
      >
        <ActionIcons.download className="size-4 transition-transform duration-fast ease-out-soft group-hover/action:translate-y-0.5 motion-reduce:transition-none" />
      </a>
    </Button>
  );
}

function VersionsDialog({
  item,
  open,
  onOpenChange,
  onRestored,
}: {
  item: LibItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestored: () => void;
}) {
  const [versions, setVersions] = React.useState<LibVersion[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [restoring, setRestoring] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (!open || !item) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/attachments/${item.id}/versions`)
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return (await response.json()) as { versions?: LibVersion[] };
      })
      .then((data) => {
        if (!cancelled) setVersions(data.versions ?? []);
      })
      .catch(() => {
        if (!cancelled) toast.error("Couldn’t load file versions.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, item]);

  const restore = async (version: LibVersion) => {
    if (!item || version.current) return;
    setRestoring(version.version);
    try {
      const response = await fetch(`/api/attachments/${item.id}/versions/${version.version}/restore`, { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Couldn’t restore that version.");
      toast.success(`Restored version ${version.version}.`);
      onOpenChange(false);
      onRestored();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t restore that version.");
    } finally {
      setRestoring(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>File versions</DialogTitle>
          <DialogDescription>{item?.fileName ?? ""} — prior bytes remain recoverable.</DialogDescription>
        </DialogHeader>
        <div className="max-h-72 space-y-2 overflow-y-auto">
          {loading ? (
            // A skeleton in the shape of the rows, not the word "Loading" — the
            // dialog is the one place in this page that still announced its wait
            // in prose while every list around it drew the shape it was fetching.
            <div className="space-y-2" role="status" aria-label="Loading versions">
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton h-14 rounded-field" style={{ animationDelay: `${i * 60}ms` }} />
              ))}
            </div>
          ) : versions.length === 0 ? (
            <EmptyState size="panel" icon={History} title="No saved versions yet" description="Re-uploading this file keeps the bytes it replaces." />
          ) : (
            versions.map((version) => (
              <div key={version.version} className="flex items-center gap-3 rounded-field border border-border/60 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    v{version.version} {version.current ? "· current" : ""}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {version.fileName} · {formatBytes(version.size)} · {timeAgo(version.createdAt)}
                  </p>
                </div>
                {!version.current && (
                  <Button size="sm" variant="outline" onClick={() => restore(version)} disabled={restoring !== null}>
                    {restoring === version.version ? "Restoring…" : "Restore"}
                  </Button>
                )}
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MobileItemMenu({
  item,
  onRename,
  onDelete,
  onRestore,
  onVersions,
  triggerClassName,
}: {
  item: LibItem;
  onRename: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onVersions: () => void;
  triggerClassName?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Actions for ${item.fileName}`}
          className={cn("text-muted-foreground", triggerClassName ?? "sm:hidden")}
        >
          <ActionIcons.more className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        {item.deletedAt ? (
          <DropdownMenuItem onSelect={onRestore}>
            <ActionIcons.restore /> Restore
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={onRename}>
            <ActionIcons.edit /> Rename
          </DropdownMenuItem>
        )}
        {item.versionCount > 0 && <DropdownMenuItem onSelect={onVersions}><History /> Versions</DropdownMenuItem>}
        {!item.deletedAt && (
          <DropdownMenuItem asChild>
            <a href={item.url} target="_blank" rel="noopener noreferrer" download={item.fileName}>
              <ActionIcons.download /> Download
            </a>
          </DropdownMenuItem>
        )}
        {item.conversationId && (
          <DropdownMenuItem asChild>
            <Link href={`/chat/${item.conversationId}`}>
              <MessageCircle /> Open source chat
            </Link>
          </DropdownMenuItem>
        )}
        {!item.deletedAt && (
          <>
            <DropdownMenuSeparator />
            {/* Tint on focus, matching Projects and Artifacts — this had no ground
                at all, so arrow-keying to Delete looked different on every page. */}
            <DropdownMenuItem onSelect={onDelete} className="text-destructive focus:bg-destructive/10 focus:text-destructive">
              <ActionIcons.delete /> Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function GridItemPreview({ item }: { item: LibItem }) {
  const preview = <FilePreview item={item} className="size-full" sizes="(max-width: 639px) 50vw, (max-width: 1023px) 33vw, 25vw" />;
  return item.deletedAt ? (
    <div className="group/preview block size-full" aria-label={`${item.fileName} is deleted`}>{preview}</div>
  ) : (
    <a href={item.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${item.fileName}`} className="group/preview block size-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
      {preview}
    </a>
  );
}

function LibraryGridItem({
  item,
  index,
  selected,
  onToggleSelect,
  onRename,
  onDelete,
  onRestore,
  onVersions,
}: {
  item: LibItem;
  index: number;
  selected: boolean;
  onToggleSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onVersions: () => void;
}) {
  return (
    <article
      role="listitem"
      aria-label={item.fileName}
      style={staggerDelay(index, "base")}
      className="group/card min-w-0 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
    >
      <div
        className={cn(
          // rounded-card (16), the family's rung for a card in a grid — this was
          // rounded-menu (14), one of four answers to the same question.
          // bg-card, not bg-background: the tile was painted in the SAME token as
          // the page under it, so on the true-black ground it had no surface at all
          // and the hairline border was doing the entire job of separating a file
          // from the page.
          "relative aspect-square overflow-hidden rounded-card border border-border/60 bg-card transition-[border-color,transform,box-shadow] duration-base ease-out-soft group-hover/card:-translate-y-0.5 group-hover/card:border-foreground/20 motion-reduce:transition-none motion-reduce:group-hover/card:translate-y-0",
          selected && "border-foreground/40 ring-1 ring-foreground/35 ring-offset-2 ring-offset-background"
        )}
      >
        <GridItemPreview item={item} />
        <SelectCheck
          checked={selected}
          onClick={onToggleSelect}
          label={selected ? `Deselect ${item.fileName}` : `Select ${item.fileName}`}
          className={cn(
            "absolute left-2 top-2 z-10 shadow-pop transition-opacity duration-fast focus-visible:opacity-100 coarse:size-8 coarse:opacity-100",
            !selected && "opacity-0 group-focus-within/card:opacity-100 group-hover/card:opacity-100"
          )}
        />
        <MobileItemMenu
          item={item}
          onRename={onRename}
          onDelete={onDelete}
          onRestore={onRestore}
          onVersions={onVersions}
          triggerClassName="absolute right-2 top-2 z-10 bg-background/90 text-foreground opacity-0 shadow-pop backdrop-blur-sm transition-opacity duration-fast hover:bg-background group-focus-within/card:opacity-100 group-hover/card:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 coarse:opacity-100"
        />
      </div>

      <div className="flex min-w-0 items-start gap-2 px-1 pb-1 pt-2.5">
        <div className="min-w-0 flex-1">
          {item.deletedAt ? (
            <p className="block truncate text-sm font-medium text-muted-foreground" title={`${item.fileName} is deleted`}>
              {item.fileName}
            </p>
          ) : (
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              title={item.fileName}
              className="block truncate text-sm font-medium underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {item.fileName}
            </a>
          )}
          <p className="mt-0.5 truncate text-caption tabular-nums text-muted-foreground">
            {formatBytes(item.size)} · {timeAgo(item.createdAt)}
          </p>
          {item.knowledge?.documentId ? (
            <Link href={`/knowledge/documents/${item.knowledge.documentId}`} className="block max-w-full">
              <IndexStatus status={item.knowledge} className="mt-0.5 max-w-full hover:underline" />
            </Link>
          ) : (
            <IndexStatus status={item.knowledge ?? null} className="mt-0.5 max-w-full" />
          )}
        </div>
        {item.conversationId && (
          <Link
            href={`/chat/${item.conversationId}`}
            aria-label={`Open source chat for ${item.fileName}`}
            title="Open source chat"
            className="group/source flex size-8 shrink-0 items-center justify-center rounded-control text-muted-foreground transition-colors duration-fast hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring coarse:size-10"
          >
            <MessageCircle className="size-3.5 transition-transform duration-fast ease-out-soft group-hover/source:-translate-y-0.5 motion-reduce:transition-none" />
          </Link>
        )}
      </div>
    </article>
  );
}

function LoadingBrowser({ view }: { view: LibraryView }) {
  if (view === "grid") {
    return (
      <div
        className="mt-5 grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 sm:gap-x-4 lg:grid-cols-4"
        aria-label="Loading files"
      >
        {[...Array(8)].map((_, index) => (
          <div key={index}>
            <div
              className="skeleton aspect-square rounded-card"
              style={staggerDelay(index, "base")}
            />
            <div className="px-1 pt-2.5">
              <span className="skeleton block h-3 w-3/4 rounded-sm" />
              <span className="skeleton mt-2 block h-2.5 w-1/2 rounded-sm" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    // bg-card, like the browser this stands in for. Without it the skeleton was
    // an unfilled outline on the black page and the real panel arrived carrying a
    // surface, so the load ended with the whole list stepping up a rung.
    <div className="mt-5 overflow-hidden rounded-popover border border-border/60 bg-card" aria-label="Loading files">
      {/* Same rung as the loaded browser's header — a skeleton that paints a
          different tone than the thing it stands in for is a visible swap. */}
      <div className={cn(browserGrid, "h-10 border-b border-border/50 bg-secondary px-3 sm:px-4")}>
        <span className="skeleton size-4 rounded-xs" />
        <span className="skeleton h-2.5 w-16 rounded-sm" />
      </div>
      {[...Array(6)].map((_, index) => (
        <div
          key={index}
          className={cn(browserGrid, "min-h-[72px] border-b border-border/40 px-3 last:border-0 sm:px-4")}
        >
          <span className="skeleton size-5 rounded-xs" style={staggerDelay(index, "tight")} />
          <span className="flex items-center gap-3">
            <span className="skeleton size-11 shrink-0 rounded-control" style={staggerDelay(index, "tight")} />
            <span className="min-w-0 flex-1 space-y-2">
              <span className="skeleton block h-3 w-32 max-w-full rounded-sm" />
              <span className="skeleton block h-2.5 w-20 rounded-sm" />
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

export default function LibraryPage() {
  const [items, setItems] = React.useState<LibItem[] | null>(null);
  const [error, setError] = React.useState(false);
  const [tab, setTab] = React.useState<LibraryFilter>("all");
  const [query, setQuery] = React.useState("");
  const [view, setView] = React.useState<LibraryView>("list");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [renameTarget, setRenameTarget] = React.useState<LibItem | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [deleteTargets, setDeleteTargets] = React.useState<LibItem[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [showDeleted, setShowDeleted] = React.useState(false);
  const [versionsTarget, setVersionsTarget] = React.useState<LibItem | null>(null);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);

  const load = React.useCallback(async (append = false, cursor: string | null = null) => {
    setError(false);
    if (append) setLoadingMore(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (showDeleted) params.set("includeDeleted", "true");
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(`/api/library?${params.toString()}`);
      if (!response.ok) throw new Error();
      const data = await response.json();
      setItems((previous) => (append ? [...(previous ?? []), ...(data.items ?? [])] : data.items ?? []));
      setNextCursor(data.nextCursor ?? null);
    } catch {
      setError(true);
      if (!append) setItems([]);
    } finally {
      if (append) setLoadingMore(false);
    }
  }, [showDeleted]);

  React.useEffect(() => {
    setNextCursor(null);
    load();
  }, [load]);

  React.useEffect(() => {
    try {
      const savedView = window.localStorage.getItem(LIBRARY_VIEW_STORAGE_KEY);
      if (savedView === "list" || savedView === "grid") setView(savedView);
    } catch {
      // Storage can be unavailable in hardened browsing modes; list remains the safe default.
    }
  }, []);

  const libraryItems = items ?? [];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = libraryItems.filter(
    (item) =>
      (tab === "all" || item.kind === tab) &&
      (!normalizedQuery ||
        item.fileName.toLocaleLowerCase().includes(normalizedQuery) ||
        item.mimeType.toLocaleLowerCase().includes(normalizedQuery))
  );
  const loading = items === null;
  const libraryEmpty = !loading && libraryItems.length === 0;
  const noResults = !loading && !libraryEmpty && filtered.length === 0;
  const selectedItems = libraryItems.filter((item) => selected.has(item.id));
  const allSelected = filtered.length > 0 && filtered.every((item) => selected.has(item.id));
  const someSelected = !allSelected && filtered.some((item) => selected.has(item.id));
  const totalSize = libraryItems.reduce((sum, item) => sum + item.size, 0);

  const toggleSelect = (id: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const clearSelection = () => setSelected(new Set());

  const toggleSelectAll = () =>
    setSelected((previous) => {
      const next = new Set(previous);
      filtered.forEach((item) => {
        if (allSelected) next.delete(item.id);
        else next.add(item.id);
      });
      return next;
    });

  const clearFilters = () => {
    setTab("all");
    setQuery("");
  };

  const changeView = (nextView: LibraryView) => {
    setView(nextView);
    try {
      window.localStorage.setItem(LIBRARY_VIEW_STORAGE_KEY, nextView);
    } catch {
      // The in-memory preference still works when local storage is unavailable.
    }
  };

  const openRename = (item: LibItem) => {
    setRenameValue(item.fileName);
    setRenameTarget(item);
  };

  const doRename = async () => {
    if (!renameTarget) return;
    const name = renameValue.trim();
    if (!name || name === renameTarget.fileName) {
      setRenameTarget(null);
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/attachments/${renameTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: name }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Could not rename.");
      setItems(
        (previous) =>
          previous?.map((item) =>
            item.id === renameTarget.id ? { ...item, fileName: data.fileName ?? name } : item
          ) ?? previous
      );
      toast.success("Renamed.");
      setRenameTarget(null);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not rename.");
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    if (!deleteTargets || deleteTargets.length === 0) return;
    const ids = deleteTargets.map((target) => target.id);
    setBusy(true);
    const results = await Promise.allSettled(
      ids.map((id) =>
        fetch(`/api/attachments/${id}`, { method: "DELETE" }).then((response) => {
          if (!response.ok) throw new Error();
          return id;
        })
      )
    );
    const okIds = new Set(results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])));
    setItems((previous) => previous?.filter((item) => !okIds.has(item.id)) ?? previous);
    setSelected((previous) => {
      const next = new Set(previous);
      okIds.forEach((id) => next.delete(id));
      return next;
    });
    const failed = ids.length - okIds.size;
    if (failed) toast.error(`${failed} ${failed === 1 ? "item" : "items"} couldn’t be deleted.`);
    else toast.success(`Deleted ${okIds.size} ${okIds.size === 1 ? "item" : "items"}.`);
    setBusy(false);
    setDeleteTargets(null);
  };

  const restoreItems = async (targets: LibItem[]) => {
    if (targets.length === 0) return;
    setBusy(true);
    const results = await Promise.allSettled(
      targets.map((target) =>
        fetch(`/api/attachments/${target.id}/restore`, { method: "POST" }).then((response) => {
          if (!response.ok) throw new Error();
          return target.id;
        }),
      ),
    );
    const restored = new Set(results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])));
    setItems((previous) => previous?.filter((item) => !restored.has(item.id)) ?? previous);
    const failed = targets.length - restored.size;
    if (failed) toast.error(`${failed} ${failed === 1 ? "item" : "items"} couldn’t be restored.`);
    else toast.success(`Restored ${restored.size} ${restored.size === 1 ? "item" : "items"}.`);
    setSelected((previous) => {
      const next = new Set(previous);
      restored.forEach((id) => next.delete(id));
      return next;
    });
    setBusy(false);
  };

  return (
    <div className="app-page-scroll">
      <main className="app-page-content max-w-6xl">
        {/* "Recently deleted" is a MODE, not a filter, so it has to be legible in
            the heading — the h1 used to keep saying "Your files" while the list
            showed the trash, and the only tell was the toggle's own label. */}
        <AppPageHeader
          eyebrow="Library"
          heading={showDeleted ? "Recently deleted" : "Your files"}
          icon={AppIcons.library}
          lede={
            showDeleted
              ? "Files you delete land here and stay recoverable."
              : "Images and documents shared across your conversations."
          }
          actions={
            <>
              {!loading && !error && (
                <p className="hidden items-center gap-2 font-mono text-caption tabular-nums text-muted-foreground sm:flex">
                  {/* A count that changes when you press "Load more" is worse than no
                      count: load() asks for 100 at a time, so until the cursor is
                      spent this is a floor, and the byte total is a partial sum that
                      must not be presented as a total. */}
                  <span>
                    {nextCursor
                      ? `${libraryItems.length}+ items`
                      : `${libraryItems.length} ${libraryItems.length === 1 ? "item" : "items"}`}
                  </span>
                  {!nextCursor && (
                    <>
                      <span aria-hidden="true" className="size-1 rounded-full bg-border" />
                      <span>{formatBytes(totalSize)}</span>
                    </>
                  )}
                </p>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSelected(new Set());
                  setShowDeleted((value) => !value);
                }}
                className="shrink-0 gap-1.5 text-muted-foreground"
              >
                <ActionIcons.restore className="size-3.5" />
                {showDeleted ? "Back to library" : "Recently deleted"}
              </Button>
            </>
          }
        />

        {!error && (
          <div className="sticky top-0 z-20 -mx-1 border-b border-border/55 bg-background/90 px-1 py-3 backdrop-blur-xl supports-[backdrop-filter]:bg-background/75">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              {/* Chips in a radiogroup, matching Artifacts — the closer sibling,
                  since both filter one list by content type. This was raw buttons
                  with aria-pressed (wrong for a single-select) plus an underline
                  positioned at -bottom-[13px], an offset hard-tied to the bar's
                  py-3 that detached the moment that padding changed. */}
              <div role="radiogroup" aria-label="Filter files" className="flex flex-wrap items-center gap-1.5">
                {TABS.map((filter) => {
                  const active = tab === filter.key;
                  return (
                    <button
                      key={filter.key}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setTab(filter.key)}
                      className={cn(
                        "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-all duration-base ease-out-soft active:scale-95",
                        active
                          ? "border-foreground/40 bg-foreground text-background shadow-xs"
                          : "border-border/70 bg-secondary/80 text-muted-foreground hover:bg-accent hover:text-foreground"
                      )}
                    >
                      <span>{filter.label}</span>
                      <span className={cn("font-mono text-micro tabular-nums", active ? "text-background/80" : "text-muted-foreground/80")}>
                        {countFor(libraryItems, filter.key)}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="flex min-w-0 flex-1 items-center gap-2 sm:justify-end">
                {/* The focus affordance was a foreground-tinted box-shadow — the exact
                    white-halo pattern the shadow rebase removed, which on the true-black
                    ground painted a glow around the field instead of a ring. It is the
                    ring token now, like every other focusable surface. */}
                <div className="group/search flex h-9 min-w-0 flex-1 items-center gap-2 rounded-control border border-border/60 bg-card px-3 transition-[border-color,box-shadow] duration-fast ease-out-soft focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 motion-reduce:transition-none sm:max-w-[16rem]">
                  <Search className="size-3.5 shrink-0 text-muted-foreground transition-colors group-focus-within/search:text-foreground" />
                  <label htmlFor="library-search" className="sr-only">Search files</label>
                  <input
                    id="library-search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search files"
                    className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery("")}
                      aria-label="Clear search"
                      className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ActionIcons.dismiss className="size-3.5" />
                    </button>
                  )}
                </div>
                {/* Was a hand-rolled track with a flat `bg-foreground text-background`
                    active fill — an inverted-solid selection that appears in no other
                    toggle in the product, and with none of the thumb's travel. */}
                <SegmentedControl
                  value={view}
                  onChange={changeView}
                  options={VIEW_OPTIONS}
                  ariaLabel="File view"
                  className="h-9 shrink-0"
                />
                {!loading && filtered.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={toggleSelectAll}
                    className={cn("shrink-0 text-muted-foreground", view === "list" && "sm:hidden")}
                  >
                    {allSelected ? "Clear visible" : "Select"}
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}

        {selectedItems.length > 0 && (
          <div
            className="mt-4 flex min-h-11 flex-wrap items-center gap-2 border-y border-border/60 bg-muted/50 px-2 py-1.5 motion-safe:animate-fade-in sm:px-3"
            aria-live="polite"
          >
            <span className="text-sm font-medium tabular-nums">
              {selectedItems.length} selected
            </span>
            <div className="ml-auto flex items-center gap-0.5">
              {selectedItems.length === 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-muted-foreground hover:text-foreground"
                  onClick={() => openRename(selectedItems[0])}
                >
                  <ActionIcons.edit className="size-3.5" />
                  <span className="hidden sm:inline">Rename</span>
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="danger-hover gap-1.5 text-muted-foreground"
                onClick={() => (showDeleted ? void restoreItems(selectedItems) : setDeleteTargets(selectedItems))}
              >
                {showDeleted ? <ActionIcons.restore className="size-3.5" /> : <ActionIcons.delete className="size-3.5" />}
                <span className="hidden sm:inline">{showDeleted ? "Restore" : "Delete"}</span>
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={clearSelection} aria-label="Clear selection">
                <ActionIcons.dismiss className="size-4" />
              </Button>
            </div>
          </div>
        )}

        {error ? (
          <EmptyState
            tone="error"
            className="mt-6"
            title="Couldn’t load your library"
            description="Check your connection and try once more."
            action={
              <Button variant="outline" size="sm" onClick={() => load()} className="group/retry gap-2">
                <ActionIcons.refresh className="size-3.5 transition-transform duration-base group-hover/retry:rotate-45 motion-reduce:transition-none" />
                Try again
              </Button>
            }
          />
        ) : loading ? (
          <LoadingBrowser view={view} />
        ) : libraryEmpty && showDeleted ? (
          // An empty TRASH is not an empty library. This branch used to claim "Your
          // library is empty" and offer "Go to chat", both false: the library still
          // has files, and chatting does not put anything in Recently deleted.
          <EmptyState
            className="mt-6"
            icon={AppIcons.library}
            title="Nothing in Recently deleted"
            description="Files you delete land here and stay recoverable."
            action={
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => {
                  setSelected(new Set());
                  setShowDeleted(false);
                }}
              >
                Back to library
              </Button>
            }
          />
        ) : libraryEmpty ? (
          <EmptyState
            className="mt-6"
            icon={AppIcons.library}
            title="Your library is empty"
            description="Files and images you share with Juno will appear here automatically."
            action={
              <Button variant="outline" size="sm" asChild>
                <Link href="/chat">Go to chat</Link>
              </Button>
            }
          />
        ) : noResults ? (
          // One no-results shape across projects / artifacts / library.
          <EmptyState
            className="mt-6"
            size="panel"
            icon={Search}
            title="No matching files"
            description="Try another search or remove the current filter."
            action={
              <Button variant="ghost" size="sm" onClick={clearFilters} className="text-muted-foreground">
                Clear filters
              </Button>
            }
          />
        ) : view === "grid" ? (
          // The container-level fade is gone: it repainted every tile at once while
          // this page's own skeletons staggered, so the loading state was more
          // choreographed than the content replacing it. Both siblings stagger.
          <section className="mt-5" aria-label="Files grid">
            <div
              role="list"
              aria-label={`${filtered.length} visible ${filtered.length === 1 ? "file" : "files"}`}
              className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 sm:gap-x-4 sm:gap-y-6 lg:grid-cols-4"
            >
              {filtered.map((item, i) => (
                <LibraryGridItem
                  key={item.id}
                  item={item}
                  index={i}
                  selected={selected.has(item.id)}
                  onToggleSelect={() => toggleSelect(item.id)}
                  onRename={() => openRename(item)}
                  onDelete={() => setDeleteTargets([item])}
                  onRestore={() => void restoreItems([item])}
                  onVersions={() => setVersionsTarget(item)}
                />
              ))}
            </div>
          </section>
        ) : (
          // bg-card, not bg-background/45: 45% of the page's own token over the
          // black ground is a no-op, so the file browser had no surface and read
          // as bare rows floating on the page.
          <section className="mt-5 overflow-hidden rounded-popover border border-border/60 bg-card" aria-label="Files">
            <div
              className={cn(
                browserGrid,
                // bg-secondary, not bg-muted/40. Re-based against the black ground
                // the whole browser had collapsed into one tone: over its bg-card
                // shell the header sat 1.2 points above it, a hovered row 1.4, and a
                // SELECTED row 1.8 — three states inside half a rung of each other,
                // so you could not tell a selected file from one the pointer was
                // merely over. Header and hover take the rung above card; selection
                // takes the one above that.
                "h-10 border-b border-border/55 bg-secondary px-3 font-mono text-caption text-muted-foreground sm:px-4"
              )}
            >
              <SelectCheck
                checked={allSelected ? true : someSelected ? "mixed" : false}
                onClick={toggleSelectAll}
                label={allSelected ? "Deselect all visible files" : "Select all visible files"}
                className="coarse:size-6"
              />
              <span>Name</span>
              <span className="hidden sm:block">Type</span>
              <span className="hidden md:block">Size</span>
              <span className="hidden sm:block">Added</span>
              <span className="sr-only">Actions</span>
            </div>

            <div role="list" aria-label={`${filtered.length} visible ${filtered.length === 1 ? "file" : "files"}`}>
              {filtered.map((item, i) => {
                const isSelected = selected.has(item.id);
                return (
                  <article
                    key={item.id}
                    role="listitem"
                    aria-label={item.fileName}
                    style={staggerDelay(i, "tight")}
                    className={cn(
                      browserGrid,
                      "group/row min-h-[72px] border-b border-border/40 px-3 transition-colors duration-fast last:border-0 hover:bg-secondary motion-safe:animate-rise-in [animation-fill-mode:backwards] sm:px-4",
                      // See the header note above: selection has to clear hover by a
                      // full rung, or the two states are the same colour.
                      isSelected && "bg-accent hover:bg-accent"
                    )}
                  >
                    <SelectCheck
                      checked={isSelected}
                      onClick={() => toggleSelect(item.id)}
                      label={isSelected ? `Deselect ${item.fileName}` : `Select ${item.fileName}`}
                      className="coarse:size-7"
                    />

                    <div className="flex min-w-0 items-center gap-3 py-2.5">
                      <ItemPreview item={item} />
                      <div className="min-w-0">
                        {item.deletedAt ? (
                          <p className="block truncate text-sm font-medium text-muted-foreground" title={`${item.fileName} is deleted`}>
                            {item.fileName}
                          </p>
                        ) : (
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block truncate text-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            title={item.fileName}
                          >
                            {item.fileName}
                          </a>
                        )}
                        <p className="mt-0.5 truncate text-caption tabular-nums text-muted-foreground sm:hidden">
                          {typeLabel(item)} · {formatBytes(item.size)} · {timeAgo(item.createdAt)}
                        </p>
                        <div className="mt-0.5 hidden min-h-4 items-center text-caption text-muted-foreground sm:flex">
                          {item.conversationId ? (
                            <Link
                              href={`/chat/${item.conversationId}`}
                              className="inline-flex items-center gap-1 underline-offset-4 transition-colors hover:text-foreground hover:underline"
                            >
                              <MessageCircle className="size-3" />
                              Open source chat
                            </Link>
                          ) : (
                            <span className="truncate">{item.mimeType}</span>
                          )}
                        </div>
                        {item.knowledge?.documentId ? (
                          <Link href={`/knowledge/documents/${item.knowledge.documentId}`} className="block max-w-full">
                            <IndexStatus status={item.knowledge} className="mt-0.5 max-w-full hover:underline" />
                          </Link>
                        ) : (
                          <IndexStatus status={item.knowledge ?? null} className="mt-0.5 max-w-full" />
                        )}
                      </div>
                    </div>

                    <span className="hidden text-xs font-medium text-muted-foreground sm:block">{typeLabel(item)}</span>
                    <span className="hidden text-xs tabular-nums text-muted-foreground md:block">{formatBytes(item.size)}</span>
                    <time
                      dateTime={item.createdAt}
                      title={new Date(item.createdAt).toLocaleString()}
                      className="hidden text-xs tabular-nums text-muted-foreground sm:block"
                    >
                      {timeAgo(item.createdAt)}
                    </time>

                    <div className="hidden items-center justify-end gap-0.5 sm:flex">
                      <ItemAction icon={ActionIcons.edit} label={`Rename ${item.fileName}`} onClick={() => openRename(item)} motion="edit" />
                      {item.versionCount > 0 && (
                        <ItemAction icon={History} label={`View versions of ${item.fileName}`} onClick={() => setVersionsTarget(item)} />
                      )}
                      <DownloadAction item={item} />
                      <ItemAction
                        icon={showDeleted ? ActionIcons.restore : ActionIcons.delete}
                        label={showDeleted ? `Restore ${item.fileName}` : `Delete ${item.fileName}`}
                        tone={showDeleted ? undefined : "danger"}
                        motion={showDeleted ? "lift" : "delete"}
                        onClick={() => (showDeleted ? void restoreItems([item]) : setDeleteTargets([item]))}
                      />
                    </div>
                    <MobileItemMenu
                      item={item}
                      onRename={() => openRename(item)}
                      onDelete={() => setDeleteTargets([item])}
                      onRestore={() => void restoreItems([item])}
                      onVersions={() => setVersionsTarget(item)}
                    />
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {nextCursor && !loading && !error && (
          <div className="mt-5 flex justify-center">
            <Button
              variant="outline"
              size="sm"
              onClick={() => load(true, nextCursor)}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading…" : "Load more files"}
            </Button>
          </div>
        )}
      </main>

      <Dialog open={!!renameTarget} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename file</DialogTitle>
            <DialogDescription>Give this file a clearer name.</DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") doRename();
            }}
            autoFocus
            aria-label="File name"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenameTarget(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={doRename} disabled={busy || !renameValue.trim()}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <VersionsDialog
        item={versionsTarget}
        open={!!versionsTarget}
        onOpenChange={(open) => !open && setVersionsTarget(null)}
        onRestored={() => void load()}
      />

      <Dialog open={!!deleteTargets} onOpenChange={(open) => !open && setDeleteTargets(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete {deleteTargets?.length === 1 ? "this file" : `${deleteTargets?.length} files`}?</DialogTitle>
            <DialogDescription>
              This moves {deleteTargets?.length === 1 ? "it" : "them"} to Recently deleted. You can restore the original bytes later.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTargets(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={doDelete} disabled={busy}>
              {busy ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

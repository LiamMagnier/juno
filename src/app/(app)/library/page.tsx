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
  Search,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ActionIcons, AppIcons } from "@/lib/app-icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Card } from "@/components/ui/card";
import { Pressable } from "@/components/ui/pressable";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
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
import { AppPage, AppPageHeader } from "@/components/app/app-page";
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
type LibrarySort = "newest" | "oldest" | "name" | "size";

const LIBRARY_VIEW_STORAGE_KEY = "juno-library-view";

const TABS: { key: LibraryFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "IMAGE", label: "Images" },
  { key: "FILE", label: "Files" },
];

const SORTS: { key: LibrarySort; label: string }[] = [
  { key: "newest", label: "Newest first" },
  { key: "oldest", label: "Oldest first" },
  { key: "name", label: "Name" },
  { key: "size", label: "Largest first" },
];

/** Checkbox · name · type · size · added · actions. The row and its header
 *  share one template so the columns line up without a table. */
const browserGrid =
  "grid grid-cols-[1.25rem_minmax(0,1fr)_2.5rem] items-center gap-3 sm:grid-cols-[1.25rem_minmax(0,1fr)_5rem_6.5rem_6.75rem] md:grid-cols-[1.25rem_minmax(0,1fr)_5.5rem_5.5rem_7rem_6.75rem]";

/** The hover-raised row, the house recipe for a row in a list. */
const rowClass =
  "group/row rounded-control border border-transparent px-3 text-left transition-[border-color,background-color,box-shadow] duration-fast ease-out-soft hover:border-border/60 hover:bg-card hover:shadow-raised motion-reduce:transition-none";

function typeLabel(item: LibItem) {
  const extension = item.fileName.includes(".") ? item.fileName.split(".").pop()?.trim() : "";
  if (extension && extension.length <= 8) return extension.toUpperCase();
  return item.kind === "IMAGE" ? "Image" : "File";
}

function countFor(items: LibItem[], filter: LibraryFilter) {
  return filter === "all" ? items.length : items.filter((item) => item.kind === filter).length;
}

function compare(sort: LibrarySort): (a: LibItem, b: LibItem) => number {
  switch (sort) {
    case "oldest":
      return (a, b) => a.createdAt.localeCompare(b.createdAt);
    case "name":
      return (a, b) => a.fileName.localeCompare(b.fileName, undefined, { sensitivity: "base", numeric: true });
    case "size":
      return (a, b) => b.size - a.size;
    default:
      return (a, b) => b.createdAt.localeCompare(a.createdAt);
  }
}

/** The two view modes, as the segmented control's options. */
const VIEW_OPTIONS = [
  { value: "list" as const, label: "List", icon: <ListIcon className="size-3.5" /> },
  { value: "grid" as const, label: "Grid", icon: <LayoutGrid className="size-3.5" /> },
];

/**
 * The shared Checkbox, stopped from reaching whatever it sits on: a grid tile's
 * thumbnail link and a list row both have their own click.
 */
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
    <Checkbox
      checked={checked === "mixed" ? "indeterminate" : checked}
      onCheckedChange={onClick}
      onClick={(event) => event.stopPropagation()}
      aria-label={label}
      className={className}
    />
  );
}

function ItemPreview({ item }: { item: LibItem }) {
  const preview = (
    <FilePreview item={item} className="absolute inset-0" sizes="44px" excerpt={false} />
  );
  // An inset well for the thumbnail, so the picture reads as set into the row
  // rather than pasted on it.
  const className = "group/preview surface-inset relative size-11 shrink-0 overflow-hidden rounded-field";
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
            // A skeleton in the shape of the rows, not the word "Loading".
            <div className="space-y-2" role="status" aria-label="Loading versions">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-14 rounded-field" style={staggerDelay(i, "tight")} />
              ))}
            </div>
          ) : versions.length === 0 ? (
            <EmptyState size="panel" icon={History} title="No saved versions yet" description="Re-uploading this file keeps the bytes it replaces." />
          ) : (
            versions.map((version) => (
              <div key={version.version} className="surface-inset flex items-center gap-3 rounded-field px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    v{version.version} {version.current ? "· current" : ""}
                  </p>
                  <p className="truncate font-mono text-caption tabular-nums text-muted-foreground">
                    {version.fileName} · {formatBytes(version.size)} · {timeAgo(version.createdAt)}
                  </p>
                </div>
                {!version.current && (
                  <Button size="sm" variant="secondary" onClick={() => restore(version)} disabled={restoring !== null}>
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
  /** `secondary` when the trigger floats over a thumbnail and needs its own plate. */
  triggerVariant?: "ghost" | "secondary";
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={triggerVariant ?? "ghost"}
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
    // This link FILLS a well that clips at rounded-field, so an outline drawn
    // 2px outside it is cut away entirely and focus would be invisible. Inset
    // ring, radius matched to the clip.
    <a href={item.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${item.fileName}`} className="group/preview block size-full focus-visible:rounded-field focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
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
    <Card
      variant="interactive"
      role="listitem"
      aria-label={item.fileName}
      style={staggerDelay(index, "base")}
      className={cn(
        "group/card flex min-w-0 flex-col p-3 motion-safe:animate-rise-in [animation-fill-mode:backwards]",
        // Selection is a border, not a second shadow: the raised tile keeps its
        // own depth and the hairline turns to ink.
        selected && "border-foreground/40 hover:border-foreground/40"
      )}
    >
      {/* The thumbnail sits on an inset well — recessed into the raised tile,
          concentric with it (16 − 12 padding ≈ field 12). */}
      <div className="surface-inset relative aspect-square overflow-hidden rounded-field">
        <GridItemPreview item={item} />
        <div
          className={cn(
            "absolute left-2 top-2 z-10 transition-opacity duration-fast ease-out-soft focus-within:opacity-100 coarse:opacity-100",
            !selected && "opacity-0 group-focus-within/card:opacity-100 group-hover/card:opacity-100"
          )}
        >
          <SelectCheck
            checked={selected}
            onClick={onToggleSelect}
            label={selected ? `Deselect ${item.fileName}` : `Select ${item.fileName}`}
            className="shadow-pop"
          />
        </div>
        <MobileItemMenu
          item={item}
          onRename={onRename}
          onDelete={onDelete}
          onRestore={onRestore}
          onVersions={onVersions}
          triggerVariant="secondary"
          triggerClassName="absolute right-2 top-2 z-10 opacity-0 transition-opacity duration-fast ease-out-soft group-focus-within/card:opacity-100 group-hover/card:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 coarse:opacity-100"
        />
      </div>

      <div className="flex min-w-0 items-start gap-2 pt-3">
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
              className="block truncate text-sm font-medium underline-offset-4 hover:underline"
            >
              {item.fileName}
            </a>
          )}
          <p className="mt-0.5 truncate font-mono text-caption tabular-nums text-muted-foreground">
            {typeLabel(item)} · {formatBytes(item.size)} · {timeAgo(item.createdAt)}
          </p>
          {item.knowledge?.documentId ? (
            <Link href={`/knowledge/documents/${item.knowledge.documentId}`} className="block max-w-full">
              <IndexStatus status={item.knowledge} className="mt-1 max-w-full hover:underline" />
            </Link>
          ) : (
            <IndexStatus status={item.knowledge ?? null} className="mt-1 max-w-full" />
          )}
        </div>
        {item.conversationId && (
          <Button
            variant="ghost"
            size="icon-sm"
            asChild
            className="group/source -mr-1 -mt-1 shrink-0 text-muted-foreground hover:text-foreground"
          >
            <Link
              href={`/chat/${item.conversationId}`}
              aria-label={`Open source chat for ${item.fileName}`}
              title="Open source chat"
            >
              <MessageCircle className="size-3.5 transition-transform duration-fast ease-out-soft group-hover/source:-translate-y-0.5 motion-reduce:transition-none" />
            </Link>
          </Button>
        )}
      </div>
    </Card>
  );
}

function LoadingBrowser({ view }: { view: LibraryView }) {
  if (view === "grid") {
    return (
      <div
        className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4"
        aria-label="Loading files"
      >
        {[...Array(8)].map((_, index) => (
          <Card key={index} className="p-3" style={staggerDelay(index, "base")}>
            <Skeleton className="aspect-square rounded-field" />
            <Skeleton className="mt-3 h-3 w-3/4 rounded-xs" />
            <Skeleton className="mt-2 h-2.5 w-1/2 rounded-xs" />
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="surface-inset mt-5 rounded-card p-1.5" aria-label="Loading files">
      <div className={cn(browserGrid, "h-9 px-3")}>
        <Skeleton className="size-[18px] rounded-xs" />
        <Skeleton className="h-2.5 w-16 rounded-xs" />
      </div>
      {[...Array(6)].map((_, index) => (
        <div key={index} className={cn(browserGrid, "min-h-[68px] px-3")}>
          <Skeleton className="size-[18px] rounded-xs" style={staggerDelay(index, "tight")} />
          <span className="flex items-center gap-3">
            <Skeleton className="size-11 shrink-0 rounded-field" style={staggerDelay(index, "tight")} />
            <span className="min-w-0 flex-1 space-y-2">
              <Skeleton className="block h-3 w-32 max-w-full rounded-xs" />
              <Skeleton className="block h-2.5 w-20 rounded-xs" />
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
  const [sort, setSort] = React.useState<LibrarySort>("newest");
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
  const filtered = libraryItems
    .filter(
      (item) =>
        (tab === "all" || item.kind === tab) &&
        (!normalizedQuery ||
          item.fileName.toLocaleLowerCase().includes(normalizedQuery) ||
          item.mimeType.toLocaleLowerCase().includes(normalizedQuery))
    )
    .sort(compare(sort));
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
    <AppPage measure="wide">
      {/* "Recently deleted" is a MODE, not a filter, so it has to be legible in
          the heading. */}
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
                {/* load() asks for 100 at a time, so until the cursor is spent
                    this is a floor, and the byte total is a partial sum that
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
              variant="secondary"
              size="sm"
              onClick={() => {
                setSelected(new Set());
                setShowDeleted((value) => !value);
              }}
              className="shrink-0 gap-1.5"
            >
              <ActionIcons.restore className="size-3.5" />
              {showDeleted ? "Back to library" : "Recently deleted"}
            </Button>
          </>
        }
      />

      {!error && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 basis-48 sm:max-w-xs">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <label htmlFor="library-search" className="sr-only">Search files</label>
            <Input
              id="library-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search files"
              className={cn("pl-9", query && "pr-10")}
            />
            {query && (
              <div className="absolute inset-y-0 right-1 flex items-center">
                <Pressable kind="icon" size="sm" onClick={() => setQuery("")} aria-label="Clear search">
                  <ActionIcons.dismiss className="size-3.5" />
                </Pressable>
              </div>
            )}
          </div>

          <SegmentedControl<LibraryFilter>
            value={tab}
            onChange={setTab}
            ariaLabel="Filter files"
            className="h-9 w-fit max-w-full shrink-0"
            options={TABS.map((filter) => ({
              value: filter.key,
              label: filter.label,
              count: countFor(libraryItems, filter.key),
            }))}
          />

          <Select value={sort} onValueChange={(value) => setSort(value as LibrarySort)}>
            <SelectTrigger className="w-40 shrink-0" aria-label="Sort files">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORTS.map((option) => (
                <SelectItem key={option.key} value={option.key}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="ml-auto flex items-center gap-2">
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
            <SegmentedControl
              value={view}
              onChange={changeView}
              options={VIEW_OPTIONS}
              ariaLabel="File view"
              className="h-9 shrink-0"
            />
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
            <Button variant="secondary" size="sm" onClick={() => load()} className="group/retry gap-2">
              <ActionIcons.refresh className="size-3.5 transition-transform duration-base group-hover/retry:rotate-45 motion-reduce:transition-none" />
              Try again
            </Button>
          }
        />
      ) : loading ? (
        <LoadingBrowser view={view} />
      ) : libraryEmpty && showDeleted ? (
        // An empty TRASH is not an empty library.
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
            <Button variant="secondary" size="sm" asChild>
              <Link href="/chat">Go to chat</Link>
            </Button>
          }
        />
      ) : noResults ? (
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
        <section className="mt-5" aria-label="Files grid">
          <div
            role="list"
            aria-label={`${filtered.length} visible ${filtered.length === 1 ? "file" : "files"}`}
            className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4"
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
        // Rows inside an inset well: the browser is recessed into the page and
        // each row lifts out of it on hover; a selected row stays lifted.
        <section className="surface-inset mt-5 rounded-card p-1.5" aria-label="Files">
          <div className={cn(browserGrid, "h-9 px-3 font-mono text-caption text-muted-foreground")}>
            <SelectCheck
              checked={allSelected ? true : someSelected ? "mixed" : false}
              onClick={toggleSelectAll}
              label={allSelected ? "Deselect all visible files" : "Select all visible files"}
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
                    rowClass,
                    "min-h-[68px] motion-safe:animate-rise-in [animation-fill-mode:backwards]",
                    isSelected && "surface-raised border-border/60 hover:border-border/60"
                  )}
                >
                  <SelectCheck
                    checked={isSelected}
                    onClick={() => toggleSelect(item.id)}
                    label={isSelected ? `Deselect ${item.fileName}` : `Select ${item.fileName}`}
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
                          className="block truncate text-sm font-medium text-foreground underline-offset-4 hover:underline"
                          title={item.fileName}
                        >
                          {item.fileName}
                        </a>
                      )}
                      <p className="mt-0.5 truncate font-mono text-caption tabular-nums text-muted-foreground sm:hidden">
                        {typeLabel(item)} · {formatBytes(item.size)} · {timeAgo(item.createdAt)}
                      </p>
                      <div className="mt-0.5 hidden min-h-4 items-center font-mono text-caption text-muted-foreground sm:flex">
                        {item.conversationId ? (
                          <Link
                            href={`/chat/${item.conversationId}`}
                            className="inline-flex items-center gap-1 underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-foreground hover:underline"
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

                  <span className="hidden font-mono text-caption text-muted-foreground sm:block">{typeLabel(item)}</span>
                  <span className="hidden font-mono text-caption tabular-nums text-muted-foreground md:block">{formatBytes(item.size)}</span>
                  <time
                    dateTime={item.createdAt}
                    title={new Date(item.createdAt).toLocaleString()}
                    className="hidden font-mono text-caption tabular-nums text-muted-foreground sm:block"
                  >
                    {timeAgo(item.createdAt)}
                  </time>

                  <div className="hidden items-center justify-end gap-0.5 opacity-0 transition-opacity duration-fast ease-out-soft focus-within:opacity-100 group-hover/row:opacity-100 sm:flex coarse:opacity-100">
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
            variant="secondary"
            size="sm"
            onClick={() => load(true, nextCursor)}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading…" : "Load more files"}
          </Button>
        </div>
      )}

      {selectedItems.length > 0 && (
        // The bulk bar floats at the bottom of the scroll region while the list
        // runs past it, and docks under the list when it does not.
        <div
          className="surface-float sticky bottom-4 z-toolbar mt-5 flex min-h-12 flex-wrap items-center gap-2 rounded-card px-3 py-2 motion-safe:animate-rise-in"
          aria-live="polite"
        >
          <span className="font-mono text-caption tabular-nums text-muted-foreground">
            {selectedItems.length} selected
          </span>
          <div className="ml-auto flex items-center gap-1">
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
              variant={showDeleted ? "secondary" : "destructive-outline"}
              size="sm"
              className="gap-1.5"
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
    </AppPage>
  );
}

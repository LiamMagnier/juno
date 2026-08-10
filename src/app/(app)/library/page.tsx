"use client";

import * as React from "react";
import { FilePreview } from "@/components/chat/file-preview";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowLeft,
  Check,
  Download,
  History,
  LayoutGrid,
  List as ListIcon,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppIcons } from "@/lib/app-icons";
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

function ViewSelector({ view, onChange }: { view: LibraryView; onChange: (view: LibraryView) => void }) {
  const options = [
    { value: "list" as const, label: "List", icon: ListIcon },
    { value: "grid" as const, label: "Grid", icon: LayoutGrid },
  ];

  return (
    <div
      role="group"
      aria-label="File view"
      className="flex h-9 shrink-0 items-center rounded-control border border-border/60 bg-background/70 p-0.5"
    >
      {options.map((option) => {
        const active = view === option.value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={active}
            aria-label={`${option.label} view`}
            title={`${option.label} view`}
            className={cn(
              "group/view flex h-7 min-w-7 items-center justify-center gap-1.5 rounded-md px-1.5 text-[11px] font-medium transition-[color,background-color,transform] duration-fast ease-out-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-95 motion-reduce:transition-none motion-reduce:active:scale-100 lg:px-2.5",
              active
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            )}
          >
            <Icon className="size-3.5 transition-transform duration-fast ease-out-soft group-hover/view:scale-105 motion-reduce:transition-none" />
            <span className="hidden lg:inline">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function SelectCheck({
  checked,
  onClick,
  label,
  className,
}: {
  checked: boolean;
  onClick: () => void;
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      aria-pressed={checked}
      aria-label={label}
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-xs border transition-[border-color,background-color,color,transform] duration-fast ease-out-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-90 coarse:size-7",
        checked
          ? "border-foreground bg-foreground text-background"
          : "border-border/80 bg-background text-transparent hover:border-foreground/50",
        className
      )}
    >
      <Check className="size-3.5" strokeWidth={2} />
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
  icon: typeof Pencil;
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
        <Download className="size-4 transition-transform duration-fast ease-out-soft group-hover/action:translate-y-0.5 motion-reduce:transition-none" />
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
            <p className="py-6 text-center text-sm text-muted-foreground">Loading versions…</p>
          ) : versions.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No saved versions yet.</p>
          ) : (
            versions.map((version) => (
              <div key={version.version} className="flex items-center gap-3 rounded-xl border border-border/60 px-3 py-2">
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
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        {item.deletedAt ? (
          <DropdownMenuItem onSelect={onRestore}>
            <RotateCcw /> Restore
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={onRename}>
            <Pencil /> Rename
          </DropdownMenuItem>
        )}
        {item.versionCount > 0 && <DropdownMenuItem onSelect={onVersions}><History /> Versions</DropdownMenuItem>}
        {!item.deletedAt && (
          <DropdownMenuItem asChild>
            <a href={item.url} target="_blank" rel="noopener noreferrer" download={item.fileName}>
              <Download /> Download
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
            <DropdownMenuItem onSelect={onDelete} className="text-destructive focus:text-destructive">
              <Trash2 /> Delete
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
  selected,
  onToggleSelect,
  onRename,
  onDelete,
  onRestore,
  onVersions,
}: {
  item: LibItem;
  selected: boolean;
  onToggleSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onVersions: () => void;
}) {
  return (
    <article role="listitem" aria-label={item.fileName} className="group/card min-w-0">
      <div
        className={cn(
          "relative aspect-square overflow-hidden rounded-menu border border-border/60 bg-background transition-[border-color,transform,box-shadow] duration-base ease-out-soft group-hover/card:-translate-y-0.5 group-hover/card:border-foreground/20 motion-reduce:transition-none motion-reduce:group-hover/card:translate-y-0",
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
            <p className="block truncate text-[13px] font-medium text-muted-foreground" title={`${item.fileName} is deleted`}>
              {item.fileName}
            </p>
          ) : (
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              title={item.fileName}
              className="block truncate text-[13px] font-medium underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {item.fileName}
            </a>
          )}
          <p className="mt-0.5 truncate text-[11px] tabular-nums text-muted-foreground">
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
              className="skeleton aspect-square rounded-menu"
              style={staggerDelay(index, "tight")}
            />
            <div className="px-1 pt-2.5">
              <span className="skeleton block h-3 w-3/4 rounded" />
              <span className="skeleton mt-2 block h-2.5 w-1/2 rounded" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="mt-5 overflow-hidden rounded-popover border border-border/60" aria-label="Loading files">
      <div className={cn(browserGrid, "h-10 border-b border-border/50 bg-muted/20 px-3 sm:px-4")}>
        <span className="skeleton size-4 rounded-xs" />
        <span className="skeleton h-2.5 w-16 rounded" />
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
              <span className="skeleton block h-3 w-32 max-w-full rounded" />
              <span className="skeleton block h-2.5 w-20 rounded" />
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

export default function LibraryPage() {
  const router = useRouter();
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
    <div className="h-full overflow-y-auto">
      <main className="mx-auto w-full max-w-6xl px-4 pb-12 pt-6 sm:px-7 sm:pb-16 sm:pt-9 lg:px-10">
        <header className="border-b border-border/55 pb-5 sm:pb-7">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => router.push("/chat")}
                aria-label="Back to chat"
                className="group/back"
              >
                <ArrowLeft className="size-4 transition-transform duration-fast ease-out-soft group-hover/back:-translate-x-0.5 motion-reduce:transition-none" />
              </Button>
              <span className="inline-flex items-center gap-1.5 font-mono text-label text-muted-foreground">
                <AppIcons.library className="size-3.5" strokeWidth={1.75} aria-hidden />
                Library
              </span>
            </div>
            {!loading && !error && (
              <p className="hidden items-center gap-2 text-xs tabular-nums text-muted-foreground sm:flex">
                <span>{libraryItems.length} {libraryItems.length === 1 ? "item" : "items"}</span>
                <span aria-hidden="true" className="size-1 rounded-full bg-border" />
                <span>{formatBytes(totalSize)}</span>
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
              <RotateCcw className="size-3.5" />
              {showDeleted ? "Back to library" : "Recently deleted"}
            </Button>
          </div>
          <div className="mt-3 max-w-2xl">
            <h1 className="font-serif text-[2.25rem] font-medium leading-[1.05] tracking-[-0.035em] sm:text-[2.75rem]">
              Your files
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Images and documents shared across your conversations.
            </p>
          </div>
        </header>

        {!error && (
          <div className="sticky top-0 z-20 -mx-1 border-b border-border/55 bg-background/90 px-1 py-3 backdrop-blur-xl supports-[backdrop-filter]:bg-background/75">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="flex items-center gap-5" aria-label="Filter files">
                {TABS.map((filter) => {
                  const active = tab === filter.key;
                  const count = countFor(libraryItems, filter.key);
                  return (
                    <button
                      key={filter.key}
                      type="button"
                      onClick={() => setTab(filter.key)}
                      aria-pressed={active}
                      className={cn(
                        "group/filter relative flex h-9 items-center gap-1.5 text-[13px] font-medium transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background",
                        active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {filter.label}
                      <span className={cn("text-[11px] tabular-nums", active ? "text-foreground/55" : "text-muted-foreground/60")}>
                        {count}
                      </span>
                      <span
                        aria-hidden="true"
                        className={cn(
                          "absolute inset-x-0 -bottom-[13px] h-px origin-center bg-foreground transition-transform duration-base ease-out-soft motion-reduce:transition-none",
                          active ? "scale-x-100" : "scale-x-0 group-hover/filter:scale-x-50"
                        )}
                      />
                    </button>
                  );
                })}
              </div>

              <div className="flex min-w-0 flex-1 items-center gap-2 sm:justify-end">
                <div className="group/search flex h-9 min-w-0 flex-1 items-center gap-2 rounded-control border border-border/60 bg-background/70 px-3 transition-[border-color,box-shadow] duration-fast focus-within:border-foreground/25 focus-within:shadow-[0_0_0_3px_hsl(var(--foreground)/0.035)] sm:max-w-[16rem]">
                  <Search className="size-3.5 shrink-0 text-muted-foreground transition-colors group-focus-within/search:text-foreground" />
                  <label htmlFor="library-search" className="sr-only">Search files</label>
                  <input
                    id="library-search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search files"
                    className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/70"
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery("")}
                      aria-label="Clear search"
                      className="rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>
                <ViewSelector view={view} onChange={changeView} />
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
            className="mt-4 flex min-h-11 flex-wrap items-center gap-2 border-y border-border/60 bg-muted/20 px-2 py-1.5 motion-safe:animate-fade-in sm:px-3"
            aria-live="polite"
          >
            <span className="text-[13px] font-medium tabular-nums">
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
                  <Pencil className="size-3.5" />
                  <span className="hidden sm:inline">Rename</span>
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="danger-hover gap-1.5 text-muted-foreground"
                onClick={() => (showDeleted ? void restoreItems(selectedItems) : setDeleteTargets(selectedItems))}
              >
                {showDeleted ? <RotateCcw className="size-3.5" /> : <Trash2 className="size-3.5" />}
                <span className="hidden sm:inline">{showDeleted ? "Restore" : "Delete"}</span>
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={clearSelection} aria-label="Clear selection">
                <X className="size-4" />
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
                <RefreshCw className="size-3.5 transition-transform duration-base group-hover/retry:rotate-45 motion-reduce:transition-none" />
                Try again
              </Button>
            }
          />
        ) : loading ? (
          <LoadingBrowser view={view} />
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
          <EmptyState
            className="mt-6"
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
          <section className="mt-5 motion-safe:animate-fade-in" aria-label="Files grid">
            <div
              role="list"
              aria-label={`${filtered.length} visible ${filtered.length === 1 ? "file" : "files"}`}
              className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 sm:gap-x-4 sm:gap-y-6 lg:grid-cols-4"
            >
              {filtered.map((item) => (
                <LibraryGridItem
                  key={item.id}
                  item={item}
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
          <section className="mt-5 overflow-hidden rounded-popover border border-border/60 bg-background/45" aria-label="Files">
            <div
              className={cn(
                browserGrid,
                "h-10 border-b border-border/55 bg-muted/20 px-3 font-mono text-[10px] text-muted-foreground sm:px-4"
              )}
            >
              <SelectCheck
                checked={allSelected}
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
              {filtered.map((item) => {
                const isSelected = selected.has(item.id);
                return (
                  <article
                    key={item.id}
                    role="listitem"
                    aria-label={item.fileName}
                    className={cn(
                      browserGrid,
                      "group/row min-h-[72px] border-b border-border/40 px-3 transition-colors duration-fast last:border-0 hover:bg-muted/25 sm:px-4",
                      isSelected && "bg-muted/35 hover:bg-muted/40"
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
                          <p className="block truncate text-[13px] font-medium text-muted-foreground" title={`${item.fileName} is deleted`}>
                            {item.fileName}
                          </p>
                        ) : (
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block truncate text-[13px] font-medium text-foreground underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            title={item.fileName}
                          >
                            {item.fileName}
                          </a>
                        )}
                        <p className="mt-0.5 truncate text-[11px] tabular-nums text-muted-foreground sm:hidden">
                          {typeLabel(item)} · {formatBytes(item.size)} · {timeAgo(item.createdAt)}
                        </p>
                        <div className="mt-0.5 hidden min-h-4 items-center text-[11px] text-muted-foreground sm:flex">
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
                      <ItemAction icon={Pencil} label={`Rename ${item.fileName}`} onClick={() => openRename(item)} motion="edit" />
                      {item.versionCount > 0 && (
                        <ItemAction icon={History} label={`View versions of ${item.fileName}`} onClick={() => setVersionsTarget(item)} />
                      )}
                      <DownloadAction item={item} />
                      <ItemAction
                        icon={showDeleted ? RotateCcw : Trash2}
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

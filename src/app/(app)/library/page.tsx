"use client";

import * as React from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowLeft,
  Check,
  Download,
  FileText,
  FolderOpen,
  ImageIcon,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { cn, formatBytes } from "@/lib/utils";

interface LibItem {
  id: string;
  kind: "IMAGE" | "FILE";
  fileName: string;
  mimeType: string;
  size: number;
  url: string;
  createdAt: string;
  conversationId: string | null;
}

type LibraryFilter = "all" | LibItem["kind"];

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
        "flex size-5 shrink-0 items-center justify-center rounded-[6px] border transition-[border-color,background-color,color,transform] duration-fast ease-out-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-90 coarse:size-7",
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
  const [failed, setFailed] = React.useState(false);

  if (item.kind === "IMAGE" && !failed) {
    return (
      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${item.fileName}`}
        className="group/preview relative size-11 shrink-0 overflow-hidden rounded-[10px] bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <Image
          src={item.url}
          alt=""
          fill
          sizes="44px"
          className="object-cover transition-transform duration-base ease-out-soft group-hover/preview:scale-[1.04] motion-reduce:transition-none"
          onError={() => setFailed(true)}
        />
      </a>
    );
  }

  return (
    <span
      className="flex size-11 shrink-0 items-center justify-center rounded-[10px] border border-border/50 bg-muted/35 text-muted-foreground"
      aria-hidden="true"
    >
      {item.kind === "IMAGE" ? <ImageIcon className="size-[18px]" /> : <FileText className="size-[18px]" />}
    </span>
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

function MobileItemMenu({
  item,
  onRename,
  onDelete,
}: {
  item: LibItem;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Actions for ${item.fileName}`}
          className="text-muted-foreground sm:hidden"
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem onSelect={onRename}>
          <Pencil /> Rename
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={item.url} target="_blank" rel="noopener noreferrer" download={item.fileName}>
            <Download /> Download
          </a>
        </DropdownMenuItem>
        {item.conversationId && (
          <DropdownMenuItem asChild>
            <Link href={`/chat/${item.conversationId}`}>
              <MessageCircle /> Open source chat
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onDelete} className="text-destructive focus:text-destructive">
          <Trash2 /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LoadingBrowser() {
  return (
    <div className="mt-5 overflow-hidden rounded-[18px] border border-border/60" aria-label="Loading files">
      <div className={cn(browserGrid, "h-10 border-b border-border/50 bg-muted/20 px-3 sm:px-4")}>
        <span className="skeleton size-4 rounded-[5px]" />
        <span className="skeleton h-2.5 w-16 rounded" />
      </div>
      {[...Array(6)].map((_, index) => (
        <div
          key={index}
          className={cn(browserGrid, "min-h-[72px] border-b border-border/40 px-3 last:border-0 sm:px-4")}
        >
          <span className="skeleton size-5 rounded-[6px]" style={{ animationDelay: `${index * 45}ms` }} />
          <span className="flex items-center gap-3">
            <span className="skeleton size-11 shrink-0 rounded-[10px]" style={{ animationDelay: `${index * 45}ms` }} />
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
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [renameTarget, setRenameTarget] = React.useState<LibItem | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [deleteTargets, setDeleteTargets] = React.useState<LibItem[] | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setError(false);
    try {
      const response = await fetch("/api/library");
      if (!response.ok) throw new Error();
      setItems((await response.json()).items);
    } catch {
      setError(true);
      setItems([]);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

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
              <span className="font-mono text-label uppercase tracking-[0.2em] text-muted-foreground">Library</span>
            </div>
            {!loading && !error && (
              <p className="hidden items-center gap-2 text-xs tabular-nums text-muted-foreground sm:flex">
                <span>{libraryItems.length} {libraryItems.length === 1 ? "item" : "items"}</span>
                <span aria-hidden="true" className="size-1 rounded-full bg-border" />
                <span>{formatBytes(totalSize)}</span>
              </p>
            )}
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
                <div className="group/search flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[10px] border border-border/60 bg-background/70 px-3 transition-[border-color,box-shadow] duration-fast focus-within:border-foreground/25 focus-within:shadow-[0_0_0_3px_hsl(var(--foreground)/0.035)] sm:max-w-[16rem]">
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
                {!loading && filtered.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={toggleSelectAll}
                    className="shrink-0 text-muted-foreground sm:hidden"
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
                onClick={() => setDeleteTargets(selectedItems)}
              >
                <Trash2 className="size-3.5" />
                <span className="hidden sm:inline">Delete</span>
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={clearSelection} aria-label="Clear selection">
                <X className="size-4" />
              </Button>
            </div>
          </div>
        )}

        {error ? (
          <div className="mt-6 flex min-h-64 flex-col items-center justify-center border-y border-border/60 px-5 py-16 text-center">
            <p className="text-sm font-medium">Couldn’t load your library.</p>
            <p className="mt-1 max-w-xs text-sm text-muted-foreground">Check your connection and try once more.</p>
            <Button variant="outline" size="sm" onClick={load} className="group/retry mt-4 gap-2">
              <RefreshCw className="size-3.5 transition-transform duration-base group-hover/retry:rotate-45 motion-reduce:transition-none" />
              Try again
            </Button>
          </div>
        ) : loading ? (
          <LoadingBrowser />
        ) : libraryEmpty ? (
          <div className="mt-6 flex min-h-72 flex-col items-center justify-center border-y border-border/60 px-5 py-16 text-center">
            <FolderOpen className="size-6 text-muted-foreground/70" strokeWidth={1.5} />
            <p className="mt-4 font-serif text-xl font-medium">Your library is empty</p>
            <p className="mt-1 max-w-sm text-sm leading-relaxed text-muted-foreground">
              Files and images you share with Juno will appear here automatically.
            </p>
            <Button variant="outline" size="sm" asChild className="mt-5">
              <Link href="/chat">Go to chat</Link>
            </Button>
          </div>
        ) : noResults ? (
          <div className="mt-6 flex min-h-64 flex-col items-center justify-center border-y border-border/60 px-5 py-16 text-center">
            <Search className="size-5 text-muted-foreground/65" />
            <p className="mt-4 text-sm font-medium">No matching files</p>
            <p className="mt-1 text-sm text-muted-foreground">Try another search or remove the current filter.</p>
            <Button variant="ghost" size="sm" onClick={clearFilters} className="mt-3 text-muted-foreground">
              Clear filters
            </Button>
          </div>
        ) : (
          <section className="mt-5 overflow-hidden rounded-[18px] border border-border/60 bg-background/45" aria-label="Files">
            <div
              className={cn(
                browserGrid,
                "h-10 border-b border-border/55 bg-muted/20 px-3 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground sm:px-4"
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
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block truncate text-[13px] font-medium text-foreground underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          title={item.fileName}
                        >
                          {item.fileName}
                        </a>
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
                      <DownloadAction item={item} />
                      <ItemAction
                        icon={Trash2}
                        label={`Delete ${item.fileName}`}
                        tone="danger"
                        motion="delete"
                        onClick={() => setDeleteTargets([item])}
                      />
                    </div>
                    <MobileItemMenu
                      item={item}
                      onRename={() => openRename(item)}
                      onDelete={() => setDeleteTargets([item])}
                    />
                  </article>
                );
              })}
            </div>
          </section>
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

      <Dialog open={!!deleteTargets} onOpenChange={(open) => !open && setDeleteTargets(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete {deleteTargets?.length === 1 ? "this file" : `${deleteTargets?.length} files`}?</DialogTitle>
            <DialogDescription>
              This permanently removes {deleteTargets?.length === 1 ? "it" : "them"} from your library and storage. This can’t be undone.
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

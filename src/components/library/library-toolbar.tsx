"use client";

import * as React from "react";
import { LayoutGrid, List as ListIcon, Loader2, Search } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pressable } from "@/components/ui/pressable";
import { IconSwapSet } from "@/components/ui/icon-swap";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type {
  LibraryCounts,
  LibraryKind,
  LibrarySort,
  LibraryStorage,
  LibraryView,
} from "@/components/library/library-types";
import { ActionIcons } from "@/lib/app-icons";
import { cn, formatBytes } from "@/lib/utils";

const KINDS: { key: LibraryKind; label: string }[] = [
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

const VIEW_OPTIONS = [
  { value: "list" as const, label: "List", icon: <ListIcon className="size-3.5" /> },
  { value: "grid" as const, label: "Grid", icon: <LayoutGrid className="size-3.5" /> },
];

/**
 * "1.2 GB of 10 GB used", in words only.
 *
 * No meter: a bar beside a number is the same fact drawn twice, and meters are
 * banned in chrome (PREMIUM_AUDIT.md §3, rule 7). The numbers come from the
 * server's own storage sum, which counts every stored object (deleted files
 * included, since they can still be restored), not from the rows on screen.
 */
export function LibraryStorageCaption({ storage, className }: { storage: LibraryStorage; className?: string }) {
  return (
    <p className={cn("text-caption tabular-nums text-muted-foreground", className)}>
      <span>{formatBytes(storage.usedBytes)}</span> of <span>{formatBytes(storage.quotaBytes)}</span> used
    </p>
  );
}

/**
 * Search, the type filter, the sort and the view.
 *
 * Search runs on the server now, so the field shows that it is working: the
 * magnifier trades places with a spinner while a query is in flight, in the
 * same cell, and the results it replaces stay on screen until the new ones
 * arrive rather than flashing to a skeleton between keystrokes.
 */
export function LibraryToolbar({
  query,
  onQueryChange,
  searching,
  kind,
  onKindChange,
  counts,
  sort,
  onSortChange,
  view,
  onViewChange,
  selectToggle,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  searching: boolean;
  kind: LibraryKind;
  onKindChange: (kind: LibraryKind) => void;
  counts: LibraryCounts | null;
  sort: LibrarySort;
  onSortChange: (sort: LibrarySort) => void;
  view: LibraryView;
  onViewChange: (view: LibraryView) => void;
  /** Select all / clear, for the grid: the list has its own header checkbox at every width. */
  selectToggle?: { allSelected: boolean; onToggle: () => void };
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-0 flex-1 basis-48 @[40rem]/page:max-w-xs">
        <span className="pointer-events-none absolute left-3 top-1/2 flex -translate-y-1/2 text-muted-foreground">
          <IconSwapSet glyphs={{ idle: Search, busy: Loader2 }} show={searching ? "busy" : "idle"} spinning="busy" className="size-4" />
        </span>
        <label htmlFor="library-search" className="sr-only">
          Search files
        </label>
        <Input
          id="library-search"
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              onQueryChange("");
            }
          }}
          placeholder="Search files"
          autoComplete="off"
          aria-busy={searching}
          className={cn("pl-9 [&::-webkit-search-cancel-button]:hidden", query && "pr-10")}
        />
        {query && (
          <div className="absolute inset-y-0 right-1 flex items-center">
            <Tooltip>
              <TooltipTrigger asChild>
                <Pressable kind="icon" size="sm" onClick={() => onQueryChange("")} aria-label="Clear search">
                  <ActionIcons.dismiss className="size-3.5" />
                </Pressable>
              </TooltipTrigger>
              <TooltipContent>Clear search</TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>

      <SegmentedControl<LibraryKind>
        value={kind}
        onChange={onKindChange}
        ariaLabel="Filter by type"
        className="h-9 w-fit max-w-full shrink-0"
        options={KINDS.map((option) => ({
          value: option.key,
          label: option.label,
          count: counts ? (option.key === "all" ? counts.all : counts[option.key]) : undefined,
        }))}
      />

      <Select value={sort} onValueChange={(value) => onSortChange(value as LibrarySort)}>
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
        {selectToggle && (
          <Button variant="ghost" size="sm" onClick={selectToggle.onToggle} className="shrink-0 text-muted-foreground">
            {selectToggle.allSelected ? "Clear selection" : "Select all"}
          </Button>
        )}
        <SegmentedControl value={view} onChange={onViewChange} options={VIEW_OPTIONS} ariaLabel="View" className="h-9 shrink-0" />
      </div>
    </div>
  );
}

/** The toolbar's placeholder, control for control, so the row does not jump when it arrives. */
export function LibraryToolbarSkeleton() {
  return (
    <div className="flex flex-wrap items-center gap-2" aria-hidden="true">
      <Skeleton className="h-9 w-full max-w-xs rounded-field" />
      <Skeleton className="h-9 w-56 rounded-menu" />
      <Skeleton className="h-9 w-40 rounded-field" />
      <Skeleton className="ml-auto h-9 w-36 rounded-menu" />
    </div>
  );
}

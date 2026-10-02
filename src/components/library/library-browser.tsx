"use client";

import * as React from "react";
import Link from "next/link";
import { FilePreview, extensionOf } from "@/components/chat/file-preview";
import { History, MessageCircle, type IconComponent } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MENU_W } from "@/components/ui/menu-recipe";
import { IndexStatus } from "@/components/library/index-status";
import { kindLabel, typeLabel, type LibraryItem, type LibraryUpload, type LibraryView } from "@/components/library/library-types";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { ActionIcons, AppIcons, StatusIcons } from "@/lib/app-icons";
import { staggerDelay } from "@/lib/motion";
import { cn, formatBytes } from "@/lib/utils";

/**
 * The Library's list and grid, and the rows for files still on their way up.
 *
 * Presentational only: rows in, callbacks out. The page owns the data and the
 * dev fixture page (`/dev/library`) renders these same components with made-up
 * rows, which is how the states that are hard to reach on a real account (a
 * failed index, an upload halfway through, a refused file) get looked at.
 *
 * THE LIST IS ROWS ON HAIRLINES, not rows in a well. It used to sit in an inset
 * box with rounded rows lifting out of it; a list that is the whole page does
 * not need a frame to say it is a list, and a box around every file browser is
 * the "assembled, not designed" tell. Hierarchy comes from the name's weight
 * against the caption rung, and the hairline is the only line.
 */

export interface LibraryRowActions {
  onToggleSelect: (id: string) => void;
  onRename: (item: LibraryItem) => void;
  onDelete: (item: LibraryItem) => void;
  onRestore: (item: LibraryItem) => void;
  onVersions: (item: LibraryItem) => void;
}

export interface LibraryUploadActions {
  onRetryUpload: (localId: string) => void;
  onDismissUpload: (localId: string) => void;
}

export interface LibraryBrowserProps extends LibraryRowActions, LibraryUploadActions {
  items: LibraryItem[];
  uploads: LibraryUpload[];
  selected: ReadonlySet<string>;
  /** The Recently deleted view: rows restore instead of delete, and do not open. */
  deletedView: boolean;
  /**
   * Deal the rows out on the shared stagger. True only for the first page the
   * reader sees: a result set changing under a search is a swap, not a reveal,
   * and re-dealing it on every keystroke would make typing feel slow.
   */
  stagger: boolean;
}

/**
 * Checkbox · name · type · size · added · actions. The row and its header
 * share one template so the columns line up without a table.
 *
 * Stepped on the CONTENT COLUMN (`page`), not the window: the fixed tracks
 * need a 40rem column before the name keeps a readable width. From there the
 * row has size and date; type joins at 48rem. Size comes first because the
 * one-line summary that carries it is phone-only, and when it waited for a
 * 64rem column a laptop with the sidebar open showed no size anywhere on the
 * row, even sorted "Largest first"; the type is already printed on the
 * thumbnail. Every per-cell `hidden`/`block` gate below rides the same two
 * queries, or a cell lands in the wrong track.
 */
const listGrid =
  "grid grid-cols-[1.25rem_minmax(0,1fr)_2.5rem] items-center gap-x-3 " +
  "@[40rem]/page:grid-cols-[1.25rem_minmax(0,1fr)_5.5rem_6rem_7.5rem] " +
  "@[48rem]/page:grid-cols-[1.25rem_minmax(0,1fr)_4.5rem_5.5rem_6rem_7.5rem]";

const captionClass = "text-caption tabular-nums text-muted-foreground";

function nameId(id: string) {
  return `library-name-${id}`;
}

/** An icon-only action with the house tooltip. */
function IconAction({
  icon: Icon,
  label,
  onClick,
  tone,
  variant = "ghost",
  className,
}: {
  icon: IconComponent;
  label: string;
  onClick: () => void;
  tone?: "danger";
  /** `secondary` when the button floats over a picture and needs its own plate. */
  variant?: "ghost" | "secondary";
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={variant}
          size="icon-sm"
          aria-label={label}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onClick();
          }}
          className={cn(
            "text-muted-foreground",
            tone === "danger" ? "danger-hover" : "hover:text-foreground",
            className,
          )}
        >
          <Icon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function DownloadAction({ item }: { item: LibraryItem }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" asChild className="text-muted-foreground hover:text-foreground">
          <a href={item.url} target="_blank" rel="noopener noreferrer" download={item.fileName} aria-label="Download">
            <ActionIcons.download className="size-4" />
          </a>
        </Button>
      </TooltipTrigger>
      <TooltipContent>Download</TooltipContent>
    </Tooltip>
  );
}

/** Every action a row has, in one menu: the whole set on a phone, the overflow on a tile. */
function ItemMenu({
  item,
  actions,
  triggerClassName,
  triggerVariant = "ghost",
}: {
  item: LibraryItem;
  actions: LibraryRowActions;
  triggerClassName?: string;
  /** `secondary` when the trigger floats over a thumbnail and needs its own plate. */
  triggerVariant?: "ghost" | "secondary";
}) {
  const deleted = !!item.deletedAt;
  return (
    <DropdownMenu>
      <Tooltip>
        <DropdownMenuTrigger asChild>
          <TooltipTrigger asChild>
            <Button
              variant={triggerVariant}
              size="icon-sm"
              aria-label="More actions"
              className={cn("text-muted-foreground data-[state=open]:bg-selected", triggerClassName)}
            >
              <ActionIcons.more className="size-4" />
            </Button>
          </TooltipTrigger>
        </DropdownMenuTrigger>
        <TooltipContent>More actions</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className={MENU_W}>
        {deleted ? (
          <DropdownMenuItem onSelect={() => actions.onRestore(item)}>
            <ActionIcons.restore /> Restore
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => actions.onRename(item)}>
            <ActionIcons.edit /> Rename
          </DropdownMenuItem>
        )}
        {item.versionCount > 0 && (
          <DropdownMenuItem onSelect={() => actions.onVersions(item)}>
            <History /> Versions
          </DropdownMenuItem>
        )}
        {!deleted && (
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
        {!deleted && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => actions.onDelete(item)} variant="destructive">
              <ActionIcons.delete /> Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The file's name, as the link that opens it (or plain text once it is deleted). */
function ItemName({ item, className }: { item: LibraryItem; className?: string }) {
  const shared = cn("block truncate text-ui font-medium", className);
  if (item.deletedAt) {
    return (
      <p id={nameId(item.id)} className={cn(shared, "text-muted-foreground")} title={item.fileName} translate="no">
        {item.fileName}
      </p>
    );
  }
  return (
    <a
      id={nameId(item.id)}
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      title={item.fileName}
      translate="no"
      className={cn(shared, "text-foreground underline-offset-4 hover:underline")}
    >
      {item.fileName}
    </a>
  );
}

/**
 * Where a file in Recently deleted still lives. Only the Library let go of it
 * (src/lib/library-removal-policy.ts), so a row that looks deleted says, in the
 * caption voice under its name, that its chat or project still has it.
 * Named `…_NOTE` so the i18n extractor collects both.
 */
const KEPT_IN_NOTE = { chat: "Still in chat", project: "Still in project" } as const;

function KeptInNote({ keptIn, className }: { keptIn: NonNullable<LibraryItem["keptIn"]>; className?: string }) {
  const Icon = keptIn === "chat" ? MessageCircle : AppIcons.projects;
  return (
    <p className={cn("flex min-w-0 items-center gap-1.5", captionClass, className)}>
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{KEPT_IN_NOTE[keptIn]}</span>
    </p>
  );
}

/** "PDF · 2.1 MB · 3d ago": the whole row's facts on one line, where there are no columns for them. */
function MetaLine({ item, className }: { item: LibraryItem; className?: string }) {
  return (
    <p className={cn("truncate", captionClass, className)}>
      <span translate="no">{typeLabel(item)}</span> · {formatBytes(item.size)} · {timeAgo(item.createdAt)}
    </p>
  );
}

function SelectBox({
  checked,
  onToggle,
  labelledBy,
  label,
  className,
}: {
  /** `"mixed"` for a select-all standing over a partially selected set. */
  checked: boolean | "mixed";
  onToggle: () => void;
  labelledBy?: string;
  label?: string;
  className?: string;
}) {
  return (
    <Checkbox
      checked={checked === "mixed" ? "indeterminate" : checked}
      onCheckedChange={onToggle}
      // A tile's thumbnail and a row both have their own click.
      onClick={(event) => event.stopPropagation()}
      aria-labelledby={labelledBy}
      aria-label={label}
      className={className}
    />
  );
}

/* ── List ─────────────────────────────────────────────────────────────── */

export function LibraryListHeader({
  allSelected,
  someSelected,
  onToggleAll,
}: {
  allSelected: boolean;
  someSelected: boolean;
  onToggleAll: () => void;
}) {
  return (
    <div className={cn(listGrid, "h-9 border-b border-border px-2", captionClass)}>
      <SelectBox
        checked={allSelected ? true : someSelected ? "mixed" : false}
        onToggle={onToggleAll}
        label={allSelected ? "Deselect all" : "Select all"}
      />
      <span>Name</span>
      <span className="hidden @[48rem]/page:block">Type</span>
      <span className="hidden @[40rem]/page:block">Size</span>
      <span className="hidden @[40rem]/page:block">Added</span>
      <span className="sr-only">Actions</span>
    </div>
  );
}

function ListThumb({ item }: { item: LibraryItem }) {
  // No excerpt at 40px: six grey lines at that size are texture, not content,
  // and skipping it keeps a long list from making a request per row.
  const preview = <FilePreview item={item} className="absolute inset-0" sizes="40px" excerpt={false} />;
  // A well the picture is set into, at the control rung: a 40px square wants
  // the same corner as the 32px buttons on the row, not a card's.
  const className = "surface-inset relative size-10 shrink-0 overflow-hidden rounded-control";
  return item.deletedAt ? (
    <div className={className} aria-hidden="true">
      {preview}
    </div>
  ) : (
    <a href={item.url} target="_blank" rel="noopener noreferrer" tabIndex={-1} aria-hidden="true" className={className}>
      {preview}
    </a>
  );
}

function LibraryListRow({
  item,
  index,
  selected,
  selecting,
  stagger,
  actions,
}: {
  item: LibraryItem;
  index: number;
  selected: boolean;
  /** Something is selected, so every row's checkbox stays in view. */
  selecting: boolean;
  stagger: boolean;
  actions: LibraryRowActions;
}) {
  const deleted = !!item.deletedAt;
  return (
    <article
      role="listitem"
      aria-labelledby={nameId(item.id)}
      style={stagger ? staggerDelay(index, "tight") : undefined}
      className={cn(
        listGrid,
        "group/row min-h-16 px-2 transition-colors duration-fast ease-out-soft motion-reduce:transition-none",
        stagger && "motion-safe:animate-rise-in [animation-fill-mode:backwards]",
        // Hover is the fill; selected is the next rung down (FLAT_UI.md §3.1),
        // so a selected row under the pointer does not lighten.
        selected ? "bg-selected" : "hover:bg-accent",
      )}
    >
      <SelectBox
        checked={selected}
        onToggle={() => actions.onToggleSelect(item.id)}
        labelledBy={nameId(item.id)}
        className={cn(
          "transition-opacity duration-fast ease-out-soft focus-visible:opacity-100 coarse:opacity-100",
          !selected && !selecting && "opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100",
        )}
      />

      <div className="flex min-w-0 items-center gap-3 py-3">
        <ListThumb item={item} />
        <div className="min-w-0 flex-1">
          <ItemName item={item} />
          <MetaLine item={item} className="mt-0.5 @[40rem]/page:hidden" />
          {/* A kept file's index is live and belongs to its chat; in Recently
              deleted the thing to say is where the file still is. */}
          {item.keptIn ? (
            <KeptInNote keptIn={item.keptIn} className="mt-0.5" />
          ) : item.knowledge ? (
            <IndexStatus status={item.knowledge} className="mt-0.5 max-w-full" />
          ) : item.conversationId && !deleted ? (
            <Link
              href={`/chat/${item.conversationId}`}
              className={cn(
                "mt-0.5 hidden w-fit items-center gap-1.5 underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-foreground hover:underline @[40rem]/page:inline-flex",
                captionClass,
              )}
            >
              <MessageCircle className="size-3" />
              Open source chat
            </Link>
          ) : null}
        </div>
      </div>

      <span className={cn("hidden truncate @[48rem]/page:block", captionClass)}>{kindLabel(item)}</span>
      <span className={cn("hidden @[40rem]/page:block", captionClass)}>{formatBytes(item.size)}</span>
      <time
        dateTime={item.createdAt}
        title={new Date(item.createdAt).toLocaleString()}
        className={cn("hidden @[40rem]/page:block", captionClass)}
      >
        {timeAgo(item.createdAt)}
      </time>

      <div className="flex items-center justify-end gap-0.5">
        <div className="hidden items-center gap-0.5 opacity-0 transition-opacity duration-fast ease-out-soft focus-within:opacity-100 group-hover/row:opacity-100 @[40rem]/page:flex coarse:opacity-100">
          {deleted ? (
            <IconAction icon={ActionIcons.restore} label="Restore" onClick={() => actions.onRestore(item)} />
          ) : (
            <>
              <IconAction icon={ActionIcons.edit} label="Rename" onClick={() => actions.onRename(item)} />
              <DownloadAction item={item} />
              <IconAction icon={ActionIcons.delete} label="Delete" tone="danger" onClick={() => actions.onDelete(item)} />
            </>
          )}
        </div>
        {/* The whole set on a phone; on a wide column only what the three
            inline actions leave out (versions, the source chat), so it is
            there only when the row has either. */}
        <ItemMenu
          item={item}
          actions={actions}
          triggerClassName={cn(
            !item.versionCount && !item.conversationId && "@[40rem]/page:hidden",
            "@[40rem]/page:opacity-0 @[40rem]/page:group-hover/row:opacity-100 @[40rem]/page:focus-visible:opacity-100 @[40rem]/page:data-[state=open]:opacity-100 coarse:opacity-100",
          )}
        />
      </div>
    </article>
  );
}

/** The paper square for a file with no server id yet: its own image, or its extension. */
function UploadThumb({ upload, className }: { upload: LibraryUpload; className?: string }) {
  return (
    <span className={cn("surface-inset relative grid shrink-0 place-items-center overflow-hidden", className)}>
      {upload.previewUrl ? (
        // A local object URL: next/image cannot optimise it and must not try.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={upload.previewUrl} alt="" className="absolute inset-0 size-full object-cover" />
      ) : (
        // The same paper and extension `FilePreview` draws for a file with no
        // excerpt, so nothing changes when the finished row replaces this one.
        <span className="absolute inset-0 grid place-items-center bg-card">
          <span className="font-mono text-caption font-medium text-muted-foreground" translate="no">
            {extensionOf({ fileName: upload.fileName, mimeType: "" })}
          </span>
        </span>
      )}
    </span>
  );
}

/**
 * Past 100% the bytes have all been sent and the server is storing them.
 * Aborting then only stops the browser listening: the file still lands, so
 * a Cancel offered at that point would remove the row for a file that is in
 * the library a moment later.
 */
function uploadSettling(upload: LibraryUpload) {
  return upload.status === "uploading" && upload.progress >= 100;
}

/** Where an upload is: a bar and a percentage while it moves, the reason once it has failed. */
function UploadStatus({ upload, onRetry }: { upload: LibraryUpload; onRetry: () => void }) {
  if (upload.status === "failed") {
    // The reason wraps rather than truncating: it is the one thing the row
    // has to say, and at phone width a truncated "This file is larger than
    // your plan…" had no tooltip to finish it.
    return (
      <p className="mt-0.5 flex min-w-0 items-start gap-1.5 text-caption text-destructive-ink">
        <StatusIcons.error className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0">
          {upload.error ?? "Upload failed."}
          {upload.retryable !== false && (
            <button
              type="button"
              onClick={onRetry}
              className="ml-1.5 font-medium text-foreground underline-offset-4 hover:underline"
            >
              Try again
            </button>
          )}
        </span>
      </p>
    );
  }
  // No live region on the figure: a polite region re-read at every percent is
  // a queue of numbers. The progress bar carries the value for anyone who asks.
  return (
    <div className="mt-1.5 flex items-center gap-2.5">
      <Progress
        value={upload.progress}
        tone="neutral"
        aria-label="Upload progress"
        className="h-1 w-full max-w-40"
      />
      <span className={cn("shrink-0", captionClass)}>
        {uploadSettling(upload) ? "Saving…" : <>{upload.progress}%</>}
      </span>
    </div>
  );
}

function LibraryUploadRow({ upload, actions }: { upload: LibraryUpload; actions: LibraryUploadActions }) {
  const failed = upload.status === "failed";
  return (
    <article
      role="listitem"
      aria-label={upload.fileName}
      aria-busy={!failed}
      className={cn(listGrid, "min-h-16 px-2 motion-safe:animate-rise-in")}
    >
      <span aria-hidden="true" />
      <div className="flex min-w-0 items-center gap-3 py-3">
        <UploadThumb upload={upload} className="size-10 rounded-control" />
        <div className="min-w-0 flex-1">
          <p className={cn("truncate text-ui font-medium", failed ? "text-muted-foreground" : "text-foreground")} translate="no">
            {upload.fileName}
          </p>
          <UploadStatus upload={upload} onRetry={() => actions.onRetryUpload(upload.localId)} />
        </div>
      </div>
      <span className={cn("hidden truncate @[48rem]/page:block", captionClass)}>{kindLabel(upload)}</span>
      <span className={cn("hidden @[40rem]/page:block", captionClass)}>{formatBytes(upload.size)}</span>
      <span className="hidden @[40rem]/page:block" aria-hidden="true" />
      <div className="flex items-center justify-end">
        {!uploadSettling(upload) && (
          <IconAction
            icon={ActionIcons.dismiss}
            label={failed ? "Dismiss" : "Cancel upload"}
            onClick={() => actions.onDismissUpload(upload.localId)}
          />
        )}
      </div>
    </article>
  );
}

export function LibraryList({
  items,
  uploads,
  selected,
  deletedView,
  stagger,
  onToggleAll,
  ...actions
}: LibraryBrowserProps & { onToggleAll: () => void }) {
  const allSelected = items.length > 0 && items.every((item) => selected.has(item.id));
  const someSelected = !allSelected && items.some((item) => selected.has(item.id));
  const selecting = selected.size > 0;
  return (
    <section aria-label={deletedView ? "Deleted files" : "Files"}>
      <LibraryListHeader allSelected={allSelected} someSelected={someSelected} onToggleAll={onToggleAll} />
      <div role="list" className="divide-y divide-border">
        {uploads.map((upload) => (
          <LibraryUploadRow key={upload.localId} upload={upload} actions={actions} />
        ))}
        {items.map((item, index) => (
          <LibraryListRow
            key={item.id}
            item={item}
            index={index}
            selected={selected.has(item.id)}
            selecting={selecting}
            stagger={stagger}
            actions={actions}
          />
        ))}
      </div>
    </section>
  );
}

/* ── Grid ─────────────────────────────────────────────────────────────── */

const gridClass =
  "grid grid-cols-2 gap-x-3 gap-y-5 @[40rem]/page:grid-cols-3 @[40rem]/page:gap-x-4 @5xl/page:grid-cols-4";

function GridThumb({ item }: { item: LibraryItem }) {
  // `sizes` can only speak in window widths, so it says the one true thing it
  // can: below 640 there is no sidebar and a tile is half the window; above it
  // the grid steps on the content column, which caps a tile near 320px.
  const preview = <FilePreview item={item} className="size-full" sizes="(max-width: 639px) 50vw, 20rem" />;
  return item.deletedAt ? (
    <div className="block size-full" aria-hidden="true">
      {preview}
    </div>
  ) : (
    // The link FILLS a well that clips at its radius, so an outline drawn
    // outside it would be cut away: an inset ring instead, matched to the clip.
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      tabIndex={-1}
      aria-hidden="true"
      className="block size-full focus-visible:rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {preview}
    </a>
  );
}

/**
 * A tile is a picture and a caption, not a card. The thumbnail well is the
 * only box; the name sits under it on the page, the way a photo library and
 * a file manager both draw one. Selection is a ring in the accent drawn
 * inside the well, so the tile does not change size and the picture is not
 * covered.
 */
function LibraryGridTile({
  item,
  index,
  selected,
  selecting,
  stagger,
  actions,
}: {
  item: LibraryItem;
  index: number;
  selected: boolean;
  selecting: boolean;
  stagger: boolean;
  actions: LibraryRowActions;
}) {
  return (
    <article
      role="listitem"
      aria-labelledby={nameId(item.id)}
      style={stagger ? staggerDelay(index, "base") : undefined}
      className={cn("group/tile flex min-w-0 flex-col", stagger && "motion-safe:animate-rise-in [animation-fill-mode:backwards]")}
    >
      <div className="surface-inset relative aspect-square overflow-hidden rounded-card">
        <GridThumb item={item} />
        {/* The hover shade and the selected ring, over the picture and under
            the controls. Colour and opacity only. */}
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 rounded-card ring-inset transition-[opacity,box-shadow] duration-fast ease-out-soft",
            selected ? "ring-2 ring-primary" : "bg-foreground/[0.04] opacity-0 group-hover/tile:opacity-100",
          )}
        />
        <div
          className={cn(
            "absolute left-3 top-3 transition-opacity duration-fast ease-out-soft focus-within:opacity-100 coarse:opacity-100",
            !selected && !selecting && "opacity-0 group-focus-within/tile:opacity-100 group-hover/tile:opacity-100",
          )}
        >
          <SelectBox checked={selected} onToggle={() => actions.onToggleSelect(item.id)} labelledBy={nameId(item.id)} />
        </div>
        <ItemMenu
          item={item}
          actions={actions}
          triggerVariant="secondary"
          triggerClassName="absolute right-2 top-2 opacity-0 transition-opacity duration-fast ease-out-soft group-focus-within/tile:opacity-100 group-hover/tile:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 coarse:opacity-100"
        />
      </div>
      <div className="min-w-0 px-0.5 pt-2.5">
        <ItemName item={item} />
        <MetaLine item={item} className="mt-0.5" />
        {item.keptIn ? (
          <KeptInNote keptIn={item.keptIn} className="mt-0.5" />
        ) : (
          item.knowledge && <IndexStatus status={item.knowledge} className="mt-0.5 max-w-full" />
        )}
      </div>
    </article>
  );
}

function LibraryUploadTile({ upload, actions }: { upload: LibraryUpload; actions: LibraryUploadActions }) {
  const failed = upload.status === "failed";
  return (
    <article role="listitem" aria-label={upload.fileName} aria-busy={!failed} className="flex min-w-0 flex-col motion-safe:animate-rise-in">
      <div className="relative">
        <UploadThumb upload={upload} className="aspect-square w-full rounded-card" />
        {!uploadSettling(upload) && (
          <IconAction
            icon={ActionIcons.dismiss}
            label={failed ? "Dismiss" : "Cancel upload"}
            onClick={() => actions.onDismissUpload(upload.localId)}
            variant="secondary"
            className="absolute right-2 top-2"
          />
        )}
      </div>
      <div className="min-w-0 px-0.5 pt-2.5">
        <p className="truncate text-ui font-medium text-foreground" translate="no">
          {upload.fileName}
        </p>
        <UploadStatus upload={upload} onRetry={() => actions.onRetryUpload(upload.localId)} />
      </div>
    </article>
  );
}

export function LibraryGrid({ items, uploads, selected, deletedView, stagger, ...actions }: LibraryBrowserProps) {
  const selecting = selected.size > 0;
  return (
    <section aria-label={deletedView ? "Deleted files" : "Files"}>
      <div role="list" className={gridClass}>
        {uploads.map((upload) => (
          <LibraryUploadTile key={upload.localId} upload={upload} actions={actions} />
        ))}
        {items.map((item, index) => (
          <LibraryGridTile
            key={item.id}
            item={item}
            index={index}
            selected={selected.has(item.id)}
            selecting={selecting}
            stagger={stagger}
            actions={actions}
          />
        ))}
      </div>
    </section>
  );
}

/* ── Loading ─────────────────────────────────────────────────────────── */

/**
 * The browser's placeholder, in the shape of the rows it stands in for.
 *
 * `announce={false}` inside a frame that is already a labelled status region
 * (the route's loading.tsx), so the region speaks once, not twice.
 */
export function LibraryBrowserSkeleton({ view, announce = true }: { view: LibraryView; announce?: boolean }) {
  const status = announce
    ? ({ role: "status", "aria-label": "Loading files" } as const)
    : ({ "aria-hidden": true } as const);
  if (view === "grid") {
    return (
      <div className={gridClass} {...status}>
        {[...Array(8)].map((_, index) => (
          <div key={index} className="[animation-fill-mode:backwards] motion-safe:animate-rise-in" style={staggerDelay(index, "base")}>
            <Skeleton className="aspect-square rounded-card" />
            <Skeleton className="mt-3 h-3 w-3/4 rounded-xs" />
            <Skeleton className="mt-2 h-2.5 w-1/2 rounded-xs" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div {...status}>
      <div className={cn(listGrid, "h-9 border-b border-border px-2")}>
        <Skeleton className="size-4.5 rounded-xs" />
        <Skeleton className="h-2.5 w-12 rounded-xs" />
      </div>
      <div className="divide-y divide-border">
        {[...Array(6)].map((_, index) => (
          <div
            key={index}
            className={cn(listGrid, "min-h-16 px-2 [animation-fill-mode:backwards] motion-safe:animate-rise-in")}
            style={staggerDelay(index, "tight")}
          >
            <span />
            <span className="flex items-center gap-3">
              <Skeleton className="size-10 shrink-0 rounded-control" />
              <span className="min-w-0 flex-1 space-y-2">
                <Skeleton className="block h-3 w-40 max-w-full rounded-xs" />
                <Skeleton className="block h-2.5 w-24 rounded-xs" />
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

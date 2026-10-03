"use client";

import { AgentFace } from "@/components/agents/agent-face";
import * as React from "react";
import Link from "next/link";
import {
  AlertCircle,
  Braces,
  Download,
  FileSpreadsheet,
  FileText,
  Globe,
  History,
  Image as ImageGlyph,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  PenTool,
  Presentation,
  RotateCcw,
  Shapes,
  Trash2,
  X,
  type IconComponent,
} from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FilePreview, useFilePreview } from "@/components/chat/file-preview";
import { DesignPoster } from "@/components/artifacts/artifact-preview";
import { ArtifactLifecycleActions } from "@/components/artifacts/artifact-lifecycle-actions";
import { normalizeAgentAvatar } from "@/lib/agents/avatar";
import { kindLabel, type LibraryItem, type LibraryUpload } from "@/components/library/library-types";
import type { LibraryMadeItem } from "@/lib/library-made";
import { cn, formatBytes } from "@/lib/utils";
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * The Library's items, as the things themselves (design V3, Library scene;
 * critique 1: the Library keeps today's features).
 *
 * One entry shape for both sources, so a file and a deck sit in one grid and
 * one list: a preview, the name (two lines before it truncates, its type's
 * mark hung on the first line), who made it and when on ONE line, and the
 * chat it came from as the line's last object, which is the way back. A
 * problem is said in words in the second ink, never alarm red, and only a
 * real fix is offered as a verb.
 *
 * Items are named by their real type (D-038): a deck, a document, a site.
 */

export interface LibraryEntry {
  key: string;
  title: string;
  /** Where the item opens: an artifact's page, a deliverable's download, a file. */
  href: string;
  /** The real type, in a word: "Deck", "Document", "Spreadsheet". */
  type: string;
  at: string;
  conversationId: string | null;
  file?: LibraryItem;
  made?: LibraryMadeItem;
  /** A made item's opening text, for its miniature. */
  preview?: string | null;
}

/** A made item's stored type, as the word a person would use (D-038). */
const MADE_TYPE_WORDS: Record<string, string> = {
  MARKDOWN: "Document",
  DOCUMENT: "Document",
  REPORT: "Report",
  SPREADSHEET: "Spreadsheet",
  PRESENTATION: "Deck",
  DECK: "Deck",
  DESIGN: "Design",
  HTML: "Site",
  SITE: "Site",
  REACT: "Component",
  CODE: "Code",
  MERMAID: "Diagram",
  SVG: "Graphic",
  PDF: "PDF",
  IMAGE: "Image",
};

export function madeTypeWord(type: string): string {
  return MADE_TYPE_WORDS[type.toUpperCase()] ?? "Document";
}

const TYPE_GLYPHS: Record<string, IconComponent> = {
  Document: FileText,
  Report: FileText,
  Text: FileText,
  PDF: FileText,
  File: FileText,
  Spreadsheet: FileSpreadsheet,
  Deck: Presentation,
  Presentation: Presentation,
  Design: PenTool,
  Site: Globe,
  Component: Braces,
  Code: Braces,
  Data: Braces,
  Diagram: Shapes,
  Graphic: Shapes,
  Image: ImageGlyph,
};

export function TypeGlyph({ type, className }: { type: string; className?: string }) {
  const Glyph = TYPE_GLYPHS[type] ?? FileText;
  return <Glyph className={cn("size-4 shrink-0 text-muted-foreground", className)} aria-hidden="true" />;
}

export function entryFromFile(file: LibraryItem): LibraryEntry {
  return {
    key: `file:${file.id}`,
    title: file.fileName,
    href: file.url,
    type: kindLabel(file),
    at: file.createdAt,
    conversationId: file.conversationId,
    file,
  };
}

export function entryFromMade(item: LibraryMadeItem & { preview?: string | null }): LibraryEntry {
  return {
    key: `${item.kind}:${item.id}`,
    title: item.title,
    href: item.href,
    type: madeTypeWord(item.type),
    at: item.updatedAt,
    conversationId: item.conversationId,
    made: item,
    preview: item.preview ?? null,
  };
}

/** "Today", "Yesterday", "Monday", "12 Sep", "12 Sep 2025": the way the Library says when. */
export function libraryWhen(iso: string, now = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(at)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return at.toLocaleDateString(undefined, { weekday: "long" });
  return at.toLocaleDateString(undefined, at.getFullYear() === now.getFullYear() ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

/** What is wrong with an item, in a sentence, or null. Only real states. */
export function entryProblem(entry: LibraryEntry): string | null {
  const knowledge = entry.file?.knowledge;
  if (knowledge?.state === "failed") return knowledge.error ?? "This file couldn’t be read for search.";
  if (knowledge?.state === "degraded") return knowledge.error ?? "Only part of this file could be read for search.";
  if (entry.made?.validated === false) return "This file didn’t pass its check when it was made, so it may not open everywhere.";
  return null;
}

/* —————————————————————————————— Previews —————————————————————————————— */

/** Strip the marks from a Markdown head so a miniature shows words, not syntax. */
function proseLines(source: string, max: number): { title: string | null; lines: string[] } {
  const rows = source
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  let title: string | null = null;
  const lines: string[] = [];
  for (const row of rows) {
    const heading = row.match(/^#{1,3}\s+(.*)$/);
    const text = (heading ? heading[1] : row)
      .replace(/^[-*+]\s+|^\d+\.\s+|^>\s?/, "")
      .replace(/[*_`~]|!?\[([^\]]*)\]\([^)]*\)/g, (match, label) => label ?? "")
      .replace(/\|/g, " ")
      .trim();
    if (!text || /^[-:\s]+$/.test(text)) continue;
    if (heading && title === null && lines.length === 0) title = text;
    else lines.push(text);
    if (lines.length >= max) break;
  }
  return { title, lines };
}

/** Body copy inside a miniature: a drawing on a 320 px canvas, scaled with it, not interface text. */
const MINI_TEXT: React.CSSProperties = { fontSize: 8.5, lineHeight: "12px" };

/**
 * A miniature: laid out once on a 320 × 240 canvas and scaled to whatever
 * width its tile has, so nothing inside can collide at any width.
 */
function Miniature({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = React.useState(0.68);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setScale(Math.round((entry.contentRect.width / 320) * 1000) / 1000);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className="absolute inset-0" aria-hidden="true">
      <div className="absolute left-0 top-0 h-[240px] w-[320px] origin-top-left" style={{ transform: `scale(${scale})` }}>
        {children}
      </div>
    </div>
  );
}

function PagePreview({ title, lines, type }: { title: string; lines: string[]; type: string }) {
  return (
    <Miniature>
      <div className="absolute inset-x-6 top-6 bottom-0 rounded-t-sm bg-background px-[18px] pt-[18px] shadow-[0_0_0_1px_hsl(var(--border)/0.7)] dark:bg-card">
        <p className="line-clamp-2 font-serif text-foreground" style={{ fontSize: 15, lineHeight: "19px" }}>{title}</p>
        {lines.length ? (
          lines.map((line, index) => (
            <p key={index} className="mt-[7px] line-clamp-3 text-muted-foreground" style={MINI_TEXT}>
              {line}
            </p>
          ))
        ) : (
          <p className="mt-[8px] text-muted-foreground" style={MINI_TEXT}>{type}</p>
        )}
      </div>
    </Miniature>
  );
}

function DeckPreview({ title, type }: { title: string; type: string }) {
  return (
    <Miniature>
      <div className="absolute inset-x-[18px] top-[18px] bottom-[18px] rounded-sm bg-background px-[16px] pt-[16px] shadow-[0_0_0_1px_hsl(var(--border)/0.7)] dark:bg-card">
        <p className="line-clamp-2 font-serif text-foreground" style={{ fontSize: 16, lineHeight: "20px" }}>{title}</p>
        <p className="mt-[4px] text-muted-foreground" style={MINI_TEXT}>{type}</p>
      </div>
    </Miniature>
  );
}

function SourcePreview({ source }: { source: string }) {
  return (
    <Miniature>
      <pre className="absolute inset-0 overflow-hidden whitespace-pre px-[20px] pt-[20px] font-mono text-foreground/70 [mask-image:linear-gradient(to_bottom,#000_55%,transparent)]" style={{ fontSize: 11.5, lineHeight: "17px" }}>
        {source.split("\n").slice(0, 12).join("\n")}
      </pre>
    </Miniature>
  );
}

function svgDataUrl(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed.startsWith("<svg") || trimmed.length > 1200 || /<script|on\w+=/i.test(trimmed)) return null;
  return `data:image/svg+xml;utf8,${encodeURIComponent(trimmed)}`;
}

/** A file that is not a picture: its rendered first page when the server made one, else its words on a page. */
function FilePagePreview({ file, type }: { file: LibraryItem; type: string }) {
  const preview = useFilePreview(file, true);
  const title = file.fileName.replace(/\.[a-z0-9]{1,6}$/i, "");
  if (preview?.thumbnailUrl) {
    return (
      <Miniature>
        <div className="absolute inset-x-6 top-6 bottom-0 overflow-hidden rounded-t-sm bg-background shadow-[0_0_0_1px_hsl(var(--border)/0.7)]">
          {/* eslint-disable-next-line @next/next/no-img-element -- a bounded JPEG of the first page, from our own route */}
          <img src={preview.thumbnailUrl} alt="" loading="lazy" decoding="async" className="size-full object-cover object-top" />
        </div>
      </Miniature>
    );
  }
  const lines = (preview?.text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4);
  return <PagePreview title={title} lines={lines} type={type} />;
}

export function EntryPreview({ entry }: { entry: LibraryEntry }) {
  if (entry.file) {
    return entry.file.kind === "IMAGE" ? <FilePreview item={entry.file} className="absolute inset-0" badge={false} /> : <FilePagePreview file={entry.file} type={entry.type} />;
  }
  const made = entry.made;
  if (!made) return null;
  const type = made.type.toUpperCase();
  if (type === "DESIGN" && made.kind === "artifact") {
    return <DesignPoster artifactId={made.id} version={made.version} alt="" className="p-3" />;
  }
  const source = entry.preview ?? "";
  if (type === "SVG" && source) {
    const src = svgDataUrl(source);
    // eslint-disable-next-line @next/next/no-img-element -- a data: URL of the artifact's own (sanitised, short) source
    if (src) return <img src={src} alt="" className="size-full object-contain p-4" loading="lazy" decoding="async" />;
  }
  if (["HTML", "REACT", "CODE", "MERMAID", "SVG"].includes(type) && source) return <SourcePreview source={source} />;
  if (entry.type === "Deck") return <DeckPreview title={entry.title} type={entry.type} />;
  const prose = source ? proseLines(source, 4) : { title: null, lines: [] };
  return <PagePreview title={prose.title ?? entry.title} lines={prose.lines} type={entry.type} />;
}

/* —————————————————————————————— Parts —————————————————————————————— */

function MadeBy({ entry, size = 16, comma = false, compact = false }: { entry: LibraryEntry; size?: number; comma?: boolean; compact?: boolean }) {
  const agent = entry.made?.agent;
  if (!agent) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground/100">
      <AgentFace avatar={normalizeAgentAvatar(agent.avatar, agent.id)} size={size} />
      {/* `compact`: on a phone's two-column grid the face alone says who; the name returns at 40rem. */}
      <span className={cn("truncate text-foreground/80", compact && "hidden @[40rem]/page:inline")}>
        {agent.name}
        {comma ? "," : ""}
      </span>
    </span>
  );
}

function ChatLink({ entry }: { entry: LibraryEntry }) {
  if (!entry.conversationId) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={`/chat/${encodeURIComponent(entry.conversationId)}`}
          aria-label={`Open the chat ${entry.title} came from`}
          className="-my-1 -mr-1 ml-auto grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring coarse:size-8"
        >
          <MessageCircle className="size-4" aria-hidden="true" />
        </Link>
      </TooltipTrigger>
      <TooltipContent side="top" align="end">
        Open the chat it came from
      </TooltipContent>
    </Tooltip>
  );
}

export function EntryProblem({ entry, className }: { entry: LibraryEntry; className?: string }) {
  const problem = entryProblem(entry);
  if (!problem) return null;
  return (
    <span className={cn("grid grid-cols-[16px_minmax(0,1fr)] items-start gap-2 text-caption text-muted-foreground", className)}>
      <AlertCircle className="mt-px size-4 text-muted-foreground" aria-hidden="true" />
      <span className="line-clamp-2 text-foreground/75">{problem}</span>
    </span>
  );
}

export interface FileActions {
  onRename: (item: LibraryItem) => void;
  onVersions: (item: LibraryItem) => void;
  onDelete: (item: LibraryItem) => void;
}

/** The one menu an item has: what you can do with it, by what it really is. */
export function EntryMenu({ entry, actions, className }: { entry: LibraryEntry; actions: FileActions; className?: string }) {
  const made = entry.made;
  if (made?.kind === "artifact") {
    return (
      <span className={className}>
        <ArtifactLifecycleActions id={made.id} title={entry.title} version={made.version} latest={made.version} />
      </span>
    );
  }
  if (made) {
    return (
      <span className={className}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" asChild className="text-muted-foreground hover:text-foreground">
              <a href={made.href} download aria-label={`Download ${entry.title}`}>
                <Download className="size-4" aria-hidden="true" />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Download</TooltipContent>
        </Tooltip>
      </span>
    );
  }
  const file = entry.file;
  if (!file) return null;
  return (
    <span className={className}>
      <DropdownMenu>
        <Tooltip>
          <DropdownMenuTrigger asChild>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${entry.title}`} className="text-muted-foreground hover:text-foreground">
                <MoreHorizontal className="size-4" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
          </DropdownMenuTrigger>
          <TooltipContent>File actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuItem asChild>
            <a href={file.url} download={file.fileName}>
              <Download className="size-4" aria-hidden="true" />
              Download
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => actions.onRename(file)}>
            <Pencil className="size-4" aria-hidden="true" />
            Rename…
          </DropdownMenuItem>
          {file.versionCount > 1 ? (
            <DropdownMenuItem onSelect={() => actions.onVersions(file)}>
              <History className="size-4" aria-hidden="true" />
              Versions…
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => actions.onDelete(file)}>
            <Trash2 className="size-4" aria-hidden="true" />
            Move to Recently deleted
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

/* —————————————————————————————— Grid tile —————————————————————————————— */

/**
 * The tile's frame: one quiet card (`surface-raised`, 12) holding its preview
 * inset by `p-1` (4), so the preview's corners are `rounded-control` (8), the
 * concentric radius, and the meta's text sits 12px in from the card's edge,
 * the same inset as its bottom. Hover lifts a pixel and takes the hairline to
 * foreground 12%; press settles to .99. Reduced motion keeps only the tone.
 */
const TILE =
  "group/tile surface-raised relative flex h-full min-w-0 flex-col rounded-card p-1 transition-[transform,border-color,box-shadow] duration-[160ms] ease-out-soft hover:-translate-y-px hover:border-foreground/[0.12] hover:shadow-raised-lg active:translate-y-0 active:scale-[0.99] active:duration-press motion-reduce:transition-[border-color] motion-reduce:hover:translate-y-0 motion-reduce:active:scale-100 dark:hover:border-white/[0.12]";
/** The inset preview well: the page ground, 8px corners, its 1px hairline drawn ABOVE the picture (::after) so an image cannot cover it. */
const PREVIEW =
  "relative aspect-[4/3] overflow-hidden rounded-control bg-background after:pointer-events-none after:absolute after:inset-0 after:rounded-control after:shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.06)] dark:after:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]";

export function EntryTile({ entry, actions }: { entry: LibraryEntry; actions: FileActions }) {
  const when = libraryWhen(entry.at);
  const external = Boolean(entry.file || entry.made?.kind === "deliverable");
  return (
    /*
     * ONE CARD PER ITEM (owner: "the way the name, date and icons are placed
     * doesn't look good"). The miniature, the name and one quiet line of
     * type and date share a single quiet card, the whole card is the target,
     * and the chat link waits for the pointer instead of sitting on every
     * tile. Every tile is the same size: a 4:3 preview and a fixed two-line
     * meta, and no problem line (owner).
     */
    <div className={TILE}>
      <a
        href={entry.href}
        {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
        aria-label={`Open ${entry.title}, ${entry.type}, ${when}`}
        className="absolute inset-0 z-[1] rounded-card focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      />
      <div className={PREVIEW}>
        <EntryPreview entry={entry} />
      </div>
      <EntryMenu
        entry={entry}
        actions={actions}
        className="absolute right-3 top-3 z-[2] rounded-control bg-background/85 opacity-0 shadow-[0_0_0_1px_hsl(var(--foreground)/0.08)] backdrop-blur-md transition-opacity duration-fast ease-out-soft focus-within:opacity-100 group-hover/tile:opacity-100 coarse:opacity-100 [&:has([data-state=open])]:opacity-100"
      />
      <div className="flex min-w-0 flex-col gap-0.5 px-2 pb-2 pt-2.5">
        <span className="truncate text-ui font-medium leading-5 tracking-[-0.006em] text-foreground">{entry.title}</span>
        <span className="flex h-5 min-w-0 items-center gap-1.5 text-caption text-muted-foreground">
          <TypeGlyph type={entry.type} className="size-3.5 shrink-0" />
          {/* Under 40rem a tile is ~170px wide: the glyph names the type and the word steps out, so the date never truncates. */}
          <span className={cn("min-w-0 truncate", !entry.made?.agent && "hidden @[40rem]/page:inline")}>
            {entry.made?.agent ? <MadeBy entry={entry} size={14} compact /> : entry.type}
          </span>
          <span aria-hidden="true" className={cn("text-muted-foreground/60", !entry.made?.agent && "hidden @[40rem]/page:inline")}>·</span>
          <span className="shrink-0 tabular-nums">{when}</span>
          <span className="relative z-[2] ml-auto opacity-0 transition-opacity duration-fast ease-out-soft group-hover/tile:opacity-100 focus-within:opacity-100 coarse:opacity-100">
            <ChatLink entry={entry} />
          </span>
        </span>
      </div>
    </div>
  );
}

/**
 * A file on its way up, in the grid: the same card at the same size as every
 * other tile, its name, and its progress or the way out of a failure on the
 * tile's one meta line (no problem paragraph on a tile; the reason rides the
 * line's title and the list view still says it in full).
 */
export function UploadTile({ upload, onRetry, onDismiss }: { upload: LibraryUpload; onRetry: () => void; onDismiss: () => void }) {
  const failed = upload.status === "failed";
  return (
    <div className={cn(TILE, "hover:translate-y-0 hover:shadow-none active:scale-100")} aria-live="polite">
      <div className={cn(PREVIEW, "bg-muted dark:bg-card")}>
        {upload.previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- a local object URL of the file being uploaded
          <img src={upload.previewUrl} alt="" className="size-full object-cover opacity-60" />
        ) : (
          <span className="absolute inset-0 grid place-items-center">
            <TypeGlyph type={upload.kind === "IMAGE" ? "Image" : "File"} className="size-5 text-muted-foreground/70" />
          </span>
        )}
        {!failed ? (
          <span className="absolute inset-x-3 bottom-3 h-0.5 overflow-hidden rounded-full bg-foreground/10">
            <span className="block h-full rounded-full bg-foreground/70 transition-[width] duration-base ease-out-soft" style={{ width: `${upload.progress}%` }} />
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5 px-2 pb-2 pt-2.5">
        <span className="truncate text-ui font-medium leading-5 tracking-[-0.006em] text-foreground">{upload.fileName}</span>
        {failed ? (
          <span className="flex h-5 min-w-0 items-center gap-2 text-caption text-muted-foreground" title={upload.error ?? "This file didn’t upload."}>
            <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="sr-only">{upload.error ?? "This file didn’t upload."}</span>
            <span aria-hidden="true" className="truncate">Didn’t upload</span>
            <span className="ml-auto flex shrink-0 items-center gap-2">
              {upload.retryable !== false ? (
                <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 rounded-control font-medium text-foreground hover:underline hover:underline-offset-[3px]">
                  <RotateCcw className="size-3" aria-hidden="true" />
                  Try again
                </button>
              ) : null}
              <button type="button" onClick={onDismiss} aria-label="Dismiss" className="grid size-5 place-items-center rounded-control text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground">
                <X className="size-3" aria-hidden="true" />
              </button>
            </span>
          </span>
        ) : (
          <span className="flex h-5 items-center text-caption tabular-nums text-muted-foreground">
            {upload.progress >= 100 ? "Saving…" : `Uploading, ${Math.round(upload.progress)}%`}
          </span>
        )}
      </div>
    </div>
  );
}

/* —————————————————————————————— List row —————————————————————————————— */

/** Name · kind · added by · from · changed · size · actions, on one template with its header. */
export const LIBRARY_ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto_2rem] items-center gap-x-4 @[48rem]/page:grid-cols-[minmax(0,2.4fr)_6rem_7.5rem_minmax(0,1.6fr)_5.5rem_4.5rem_2rem]";

export function LibraryRowHead() {
  return (
    <div role="row" className={cn(LIBRARY_ROW_GRID, "mb-1 h-9 border-b border-foreground/[0.07] px-2.5 text-caption font-medium text-muted-foreground dark:border-white/[0.07]")}>
      {/* pl-11: the 32px icon column + 12px gap, so "Name" stands over the names, not the icons. */}
      <span role="columnheader" className="pl-11">Name</span>
      <span role="columnheader" className="hidden @[48rem]/page:block">Kind</span>
      <span role="columnheader" className="hidden @[48rem]/page:block">Added by</span>
      <span role="columnheader" className="hidden @[48rem]/page:block">From</span>
      <span role="columnheader" className="text-right">Changed</span>
      <span role="columnheader" className="hidden text-right @[48rem]/page:block">Size</span>
      <span role="columnheader">
        <span className="sr-only">Actions</span>
      </span>
    </div>
  );
}

export function EntryRow({ entry, actions }: { entry: LibraryEntry; actions: FileActions }) {
  const external = Boolean(entry.file || entry.made?.kind === "deliverable");
  return (
    <div
      role="row"
      className={cn(
        LIBRARY_ROW_GRID,
        "group/row h-12 rounded-control px-2.5 text-caption text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-foreground/[0.04] dark:hover:bg-white/[0.04] [&+&]:shadow-[0_-1px_0_hsl(var(--foreground)/0.07)] [&:hover+&]:shadow-none hover:shadow-none",
      )}
    >
      <span role="cell" className="flex min-w-0 items-center gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-control bg-foreground/[0.04] shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.06)] dark:bg-white/[0.04]">
          <TypeGlyph type={entry.type} className="size-4 transition-colors duration-fast ease-out-soft group-hover/row:text-foreground" />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <a
            href={entry.href}
            {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
            className="truncate text-ui leading-5 text-foreground underline-offset-[3px] hover:underline hover:decoration-border"
          >
            {entry.title}
          </a>
        </span>
      </span>
      <span role="cell" className="hidden truncate @[48rem]/page:block">{entry.type}</span>
      <span role="cell" className="hidden min-w-0 @[48rem]/page:flex">
        {entry.made?.agent ? <MadeBy entry={entry} /> : <span>{entry.file ? "You" : PRODUCT_NAME}</span>}
      </span>
      <span role="cell" className="hidden min-w-0 @[48rem]/page:block">
        {entry.conversationId ? (
          <Link href={`/chat/${encodeURIComponent(entry.conversationId)}`} className="block truncate underline-offset-[3px] hover:text-foreground hover:underline hover:decoration-border">
            Open the chat
          </Link>
        ) : (
          <span className="text-muted-foreground/80">{entry.file ? "Uploaded" : "No chat"}</span>
        )}
      </span>
      <span role="cell" className="text-right tabular-nums">{libraryWhen(entry.at)}</span>
      <span role="cell" className="hidden text-right tabular-nums @[48rem]/page:block">
        {entry.file ? formatBytes(entry.file.size) : ""}
      </span>
      <span role="cell" className="flex justify-end">
        <EntryMenu entry={entry} actions={actions} />
      </span>
    </div>
  );
}

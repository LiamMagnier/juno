"use client";

import * as React from "react";
import {
  ArrowRight,
  BookOpen,
  ChevronRight,
  CornerDownRight,
  ExternalLink,
  Folder,
  Loader2,
  Plus,
  RefreshCw,
  Upload,
} from "@/components/ui/icons";
import { ActionIcons, AppIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Pressable } from "@/components/ui/pressable";
import { Skeleton } from "@/components/ui/skeleton";
import { Collapse } from "@/components/ui/collapse";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MENU_W_WIDE, MENU_W } from "@/components/ui/menu-recipe";
import { ContextTokenMark } from "@/components/chat/context-token-mark";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { summaryExcerpt, type SummaryData } from "@/components/memory/memory-model";
import type { KnowledgeIndexState } from "@/components/library/index-status";
import { fileIconKey } from "@/lib/mentions/types";
import { formatBytes, cn } from "@/lib/utils";
import { staggerDelay } from "@/lib/motion";
import { PRODUCT_NAME } from "@/lib/brand/names";
import type { KnowledgeUsage } from "@/lib/projects/knowledge-capacity";
import {
  describeSource,
  driveWebUrl,
  type DriveAvailability,
  type ProjectSourceView,
} from "@/lib/projects/project-sources-shared";
import { GoogleDriveMark } from "@/components/projects/google-drive-mark";
import "@/components/projects/projects.css";

export interface KnowledgeFile {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  url: string;
  parserState?: string;
  /** The Drive source that mirrors it; null for an upload or a Library file. */
  sourceId: string | null;
  knowledge?: (KnowledgeIndexState & { documentId: string; tokenCount?: number }) | null;
}

export interface PanelMemoryItem {
  id: string;
  content: string;
}

/** This project's memory, as `GET /api/projects/[id]/memory` answers it. */
export interface PanelProjectMemory {
  summary: SummaryData | null;
  facts: PanelMemoryItem[];
  activeCount: number;
}

/** How many uploaded files the panel lists before "Show all". */
const FILE_PREVIEW = 6;
const MEMORY_PREVIEW = 3;
const FACT_CHARS = 96;

/**
 * The project page's right-hand panel: what every chat in this project starts
 * with. Instructions, then Knowledge (uploads, Library files and Google Drive
 * sources, with how full it is), then Memory.
 *
 * One flat in-flow surface (a hairline, no shadow), three sections on the
 * same rhythm: a 28px head row with the name on the left and at most one
 * control on the right, then the body. Rows paint nothing at rest and take
 * the tonal fill on hover, the product's list vocabulary, so the panel holds
 * three lists without reading as nine boxes.
 *
 * The Add menu is the one way in: Upload, From Library, Google Drive. With
 * nothing added yet the section's empty sentence carries the same menu as a
 * button, since that is the moment it is needed most.
 */
export function ProjectKnowledgePanel({
  coverUrl,
  onPickCover,
  onRemoveCover,
  uploadingCover = false,
  instructions,
  inherited = [],
  onEditInstructions,
  files,
  sources,
  drive,
  usage,
  canEdit,
  uploading = false,
  onUpload,
  onAddFromLibrary,
  onAddFromDrive,
  onDeleteFile,
  onSyncSource,
  onRemoveSource,
  onFixDrive,
  memory,
  onManageMemory,
  className,
  style,
}: {
  coverUrl: string | null;
  onPickCover: () => void;
  onRemoveCover: () => void;
  uploadingCover?: boolean;
  instructions: string;
  inherited?: { id: string; name: string; instructions: string; fileCount: number }[];
  onEditInstructions: () => void;
  files: KnowledgeFile[];
  sources: ProjectSourceView[];
  /** null while it loads, and for a collaborator (sources are the owner's). */
  drive: DriveAvailability | null;
  usage: KnowledgeUsage;
  /** The owner: the only one who can add or remove knowledge. */
  canEdit: boolean;
  uploading?: boolean;
  onUpload: () => void;
  onAddFromLibrary: () => void;
  onAddFromDrive: () => void;
  onDeleteFile: (fileId: string) => void;
  onSyncSource: (sourceId: string) => void;
  onRemoveSource: (source: ProjectSourceView) => void;
  /** Connect or reconnect Drive (the walk-through), for a source that needs it. */
  onFixDrive: () => void;
  memory: PanelProjectMemory | null;
  onManageMemory: () => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [showAllFiles, setShowAllFiles] = React.useState(false);
  const uploads = files.filter((file) => !file.sourceId);
  const filesBySource = React.useMemo(() => {
    const map = new Map<string, KnowledgeFile[]>();
    for (const file of files) {
      if (!file.sourceId) continue;
      map.set(file.sourceId, [...(map.get(file.sourceId) ?? []), file]);
    }
    return map;
  }, [files]);
  const itemCount = uploads.length + sources.length;
  const shownUploads = showAllFiles ? uploads : uploads.slice(0, FILE_PREVIEW);
  const inheritedFiles = inherited.reduce((sum, level) => sum + level.fileCount, 0);
  const inheritedNames = inherited.filter((level) => level.instructions.trim()).map((level) => level.name);

  const addMenu = (trigger: React.ReactNode) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={MENU_W_WIDE}>
        <DropdownMenuItem onSelect={onUpload} disabled={uploading}>
          <Upload className="size-4" aria-hidden="true" />
          <span>Upload files</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onAddFromLibrary}>
          <AppIcons.library className="size-4" aria-hidden="true" />
          <span>Add from Library</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onAddFromDrive}>
          <GoogleDriveMark className="size-4" />
          <span className="min-w-0 flex-1">Google Drive file or folder</span>
          {drive !== null && !drive.enabled && <span className="text-caption text-muted-foreground">Off</span>}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <aside aria-label="Project knowledge" className={cn("pj pj-panel overflow-hidden rounded-card", className)} style={style}>
      <div className="pj-context-header">
        <BookOpen className="size-[18px]" aria-hidden="true" />
        <h2>Project context</h2>
      </div>
      {coverUrl && (
        <div className="group/cover relative aspect-[16/5] w-full overflow-hidden bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={coverUrl} className="size-full object-cover" alt="" />
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-scrim opacity-0 transition-opacity duration-base ease-out-soft focus-within:opacity-100 group-hover/cover:opacity-100 coarse:opacity-100">
            <Button variant="secondary" size="sm" onClick={onPickCover} disabled={uploadingCover}>
              Change
            </Button>
            <Button variant="secondary" size="sm" onClick={onRemoveCover} disabled={uploadingCover}>
              Remove
            </Button>
          </div>
        </div>
      )}

      <div className="divide-y divide-[var(--pj-hair)]">
        <PanelSection
          title="Instructions"
          action={
            canEdit && (
              <Pressable kind="icon" size="sm" className="-mr-1.5 hit-44" onClick={onEditInstructions} aria-label="Edit project instructions" title="Edit instructions">
                <ActionIcons.edit className="size-3.5" aria-hidden="true" />
              </Pressable>
            )
          }
        >
          {instructions.trim() ? (
            <button
              type="button"
              onClick={onEditInstructions}
              className="-mx-2 block w-[calc(100%+1rem)] rounded-inner px-2 py-1.5 text-left transition-colors duration-fast ease-out-soft hover:bg-accent"
            >
              <p className="line-clamp-4 whitespace-pre-line break-words text-ui text-foreground">{instructions}</p>
            </button>
          ) : (
            <PanelEmpty
              description={`Tell ${PRODUCT_NAME} how to work in this project: its role, its tone, what to always or never do. Every chat here follows them.`}
              action={
                canEdit && (
                  <Button variant="outline" size="sm" onClick={onEditInstructions}>
                    Set instructions
                  </Button>
                )
              }
            />
          )}
          {inheritedNames.length > 0 && (
            <p className="pj-annot mt-2 flex items-start gap-1.5">
              <CornerDownRight className="mt-px size-3 shrink-0" aria-hidden="true" />
              <span className="min-w-0">{`Also follows ${inheritedNames.join(", then ")}`}</span>
            </p>
          )}
        </PanelSection>

        <PanelSection
          title="Knowledge"
          count={itemCount}
          action={
            canEdit &&
            addMenu(
              <Pressable kind="icon" size="sm" className="-mr-1.5 hit-44" aria-label="Add knowledge" title="Add knowledge" disabled={uploading}>
                {uploading ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Plus className="size-3.5" aria-hidden="true" />}
              </Pressable>,
            )
          }
        >
          {itemCount > 0 && <CapacityMeter usage={usage} />}

          {itemCount === 0 ? (
            <PanelEmpty
              description={`Files, Library documents and Google Drive folders every chat here can draw on. A Drive folder stays in sync as it changes.`}
              action={
                canEdit &&
                addMenu(
                  <Button variant="outline" size="sm" disabled={uploading}>
                    <Plus className="size-4" aria-hidden="true" /> Add knowledge
                  </Button>,
                )
              }
            />
          ) : (
            <ul className="-mx-2 mt-3 space-y-px" aria-label="Knowledge">
              {sources.map((source, index) => (
                <SourceRow
                  key={source.id}
                  source={source}
                  files={filesBySource.get(source.id) ?? []}
                  canEdit={canEdit}
                  index={index}
                  onSync={() => onSyncSource(source.id)}
                  onRemove={() => onRemoveSource(source)}
                  onFixDrive={onFixDrive}
                />
              ))}
              {shownUploads.map((file, index) => (
                <FileRow key={file.id} file={file} canEdit={canEdit} index={sources.length + index} onDelete={() => onDeleteFile(file.id)} />
              ))}
            </ul>
          )}
          {uploads.length > FILE_PREVIEW && (
            <PanelMore onClick={() => setShowAllFiles((value) => !value)} open={showAllFiles}>
              {showAllFiles ? "Show fewer" : `Show all ${uploads.length.toLocaleString()} files`}
            </PanelMore>
          )}
          {inheritedFiles > 0 && (
            <p className="pj-annot mt-2 flex items-start gap-1.5">
              <CornerDownRight className="mt-px size-3 shrink-0" aria-hidden="true" />
              <span className="min-w-0">{`Plus ${plural(inheritedFiles, "file")} from the folders above`}</span>
            </p>
          )}
        </PanelSection>

        <PanelSection
          title="Memory"
          count={memory?.activeCount ?? 0}
          action={
            <Pressable kind="icon" size="sm" className="-mr-1.5 hit-44" onClick={onManageMemory} aria-label="Manage this project’s memory" title="Manage memory">
              <ActionIcons.edit className="size-3.5" aria-hidden="true" />
            </Pressable>
          }
        >
          <MemoryBody memory={memory} onManageMemory={onManageMemory} />
        </PanelSection>
      </div>
    </aside>
  );
}

/**
 * The share of the project's knowledge capacity in use: one hairline track and
 * one sentence. Neutral ink until it is nearly full; the accent is kept for
 * the page's one primary action, not for a gauge.
 */
function CapacityMeter({ usage }: { usage: KnowledgeUsage }) {
  return (
    <div className="mt-1">
      <div
        role="meter"
        aria-label="Project knowledge capacity"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={usage.percent}
        aria-valuetext={usage.label}
        className="h-1 overflow-hidden rounded-full bg-foreground/[.08]"
      >
        <div
          className={cn(
            "h-full w-full rounded-full transition-transform duration-slow ease-out-soft",
            usage.full ? "bg-destructive" : usage.nearlyFull ? "bg-warning" : "bg-foreground/45",
          )}
          style={{ transform: `translateX(-${100 - usage.percent}%)` }}
        />
      </div>
      <p className={cn("mt-1.5 text-caption tabular-nums", usage.full ? "text-destructive-ink" : "text-muted-foreground")}>{usage.label}</p>
    </div>
  );
}

function SourceRow({
  source,
  files,
  canEdit,
  index,
  onSync,
  onRemove,
  onFixDrive,
}: {
  source: ProjectSourceView;
  files: KnowledgeFile[];
  canEdit: boolean;
  index: number;
  onSync: () => void;
  onRemove: () => void;
  onFixDrive: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const status = describeSource(source);
  const listId = React.useId();
  const expandable = source.kind === "folder" && (files.length > 0 || source.skipped.length > 0);
  return (
    <li className="motion-safe:animate-rise-in [animation-fill-mode:backwards]" style={staggerDelay(Math.min(index, 8))}>
      <div className="group/row flex items-start gap-2.5 rounded-inner px-2 py-1.5 transition-colors duration-fast ease-out-soft hover:bg-accent">
        <span className="relative mt-0.5 grid size-5 shrink-0 place-items-center" aria-hidden="true">
          {source.kind === "folder" ? <Folder className="size-4 text-muted-foreground" /> : <GoogleDriveMark className="size-4" />}
          {source.kind === "folder" && <GoogleDriveMark className="absolute -bottom-0.5 -right-1 size-2.5" />}
        </span>
        <div className="min-w-0 flex-1">
          {expandable ? (
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              aria-expanded={open}
              aria-controls={listId}
              className="flex w-full min-w-0 items-center gap-1 rounded-xs text-left"
            >
              <span className="truncate text-ui font-medium text-foreground">{source.name}</span>
              <ChevronRight
                className={cn("size-3 shrink-0 text-muted-foreground transition-transform duration-base ease-out-expo", open && "rotate-90")}
                aria-hidden="true"
              />
            </button>
          ) : (
            <span className="block truncate text-ui font-medium text-foreground">{source.name}</span>
          )}
          <p
            className={cn(
              "flex items-center gap-1.5 text-caption",
              status.tone === "error" ? "text-destructive-ink" : status.tone === "attention" ? "text-warning-foreground" : "text-muted-foreground",
            )}
            aria-live="polite"
          >
            {status.tone === "busy" && <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />}
            <span className={cn("min-w-0", status.tone === "error" || status.tone === "attention" ? "text-pretty" : "truncate")}>{status.text}</span>
          </p>
          {status.action && canEdit && (
            <Button
              variant="outline"
              size="xs"
              className="mt-1.5"
              onClick={status.action.kind === "retry" ? onSync : status.action.kind === "open-drive" ? () => window.open(driveWebUrl(source), "_blank", "noopener") : onFixDrive}
            >
              {status.action.kind === "retry" && <RefreshCw className="size-3" aria-hidden="true" />}
              {status.action.label}
            </Button>
          )}
        </div>
        {canEdit && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Pressable
                kind="icon"
                size="sm"
                aria-label={`Actions for ${source.name}`}
                title="More"
                className="size-6 shrink-0 opacity-0 transition-opacity duration-fast ease-out-soft hit-44 focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100 coarse:opacity-100"
              >
                <ActionIcons.more className="size-3.5" aria-hidden="true" />
              </Pressable>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={MENU_W}>
              <DropdownMenuItem onSelect={onSync} disabled={status.tone === "busy"}>
                <RefreshCw className="size-4" aria-hidden="true" />
                <span>Sync now</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => window.open(driveWebUrl(source), "_blank", "noopener")}>
                <ExternalLink className="size-4" aria-hidden="true" />
                <span>Open in Google Drive</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onRemove} variant="destructive">
                <ActionIcons.delete className="size-4" aria-hidden="true" />
                <span>Remove from project</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {expandable && (
        <Collapse open={open} innerClassName="pb-1">
          <ul id={listId} className="ml-7 border-l border-[var(--pj-hair)] pl-2" aria-label={`Files in ${source.name}`}>
            {files.map((file) => (
              <li key={file.id} className="flex min-w-0 items-center gap-2 py-1">
                <ContextTokenMark source={{ kind: "file", id: file.id, icon: fileIconKey(file.mimeType, file.fileName) }} size={16} />
                <a href={file.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate rounded-xs text-caption text-foreground hover:underline">
                  {file.fileName}
                </a>
              </li>
            ))}
            {source.skipped.map((skipped) => (
              <li key={skipped.name} className="py-1 text-caption text-muted-foreground">
                <span className="block truncate">{skipped.name}</span>
                <span className="block text-pretty text-ink-tertiary">{skipped.error}</span>
              </li>
            ))}
            {source.truncated && (
              <li className="py-1 text-caption text-muted-foreground">This folder is larger than one source holds; the rest wasn’t added.</li>
            )}
          </ul>
        </Collapse>
      )}
    </li>
  );
}

/** Index state, said the way the Library says it. */
function indexNote(file: KnowledgeFile): { text: string; failed: boolean } | null {
  const knowledge = file.knowledge;
  if (!knowledge) {
    if (file.parserState === "failed") return { text: "Couldn’t read", failed: true };
    if (file.parserState === "queued" || file.parserState === "indexing") return { text: "Indexing…", failed: false };
    return null;
  }
  if ((knowledge.state === "ready" || knowledge.state === "degraded") && knowledge.chunkCount === 0) return { text: "Indexing…", failed: false };
  switch (knowledge.state) {
    case "ready":
      return null;
    case "degraded":
      return { text: "Partly read", failed: false };
    case "failed":
      return { text: "Couldn’t read", failed: true };
    case "queued":
    case "extracting":
    case "ocr":
    case "indexing":
    case "stale":
      return { text: "Indexing…", failed: false };
    default:
      return null;
  }
}

function FileRow({ file, canEdit, index, onDelete }: { file: KnowledgeFile; canEdit: boolean; index: number; onDelete: () => void }) {
  const note = indexNote(file);
  return (
    <li
      className="group/row flex items-center gap-2.5 rounded-inner px-2 py-1.5 transition-colors duration-fast ease-out-soft hover:bg-accent motion-safe:animate-rise-in [animation-fill-mode:backwards]"
      style={staggerDelay(Math.min(index, 8))}
    >
      <ContextTokenMark source={{ kind: "file", id: file.id, icon: fileIconKey(file.mimeType, file.fileName) }} size={20} />
      <a href={file.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 rounded-xs">
        <span className="block truncate text-ui font-medium text-foreground">{file.fileName}</span>
        <span className="block truncate text-caption text-muted-foreground">
          {formatBytes(file.size)}
          {note && <span className={note.failed ? "text-destructive-ink" : undefined}>{` · ${note.text}`}</span>}
        </span>
      </a>
      {canEdit && (
        <Pressable
          kind="icon"
          size="sm"
          onClick={onDelete}
          aria-label={`Remove ${file.fileName}`}
          title="Remove"
          className="danger-hover size-6 shrink-0 opacity-0 transition-opacity duration-fast ease-out-soft hit-44 focus-visible:opacity-100 group-hover/row:opacity-100 coarse:opacity-100"
        >
          <ActionIcons.delete className="size-3.5" aria-hidden="true" />
        </Pressable>
      )}
    </li>
  );
}

function MemoryBody({ memory, onManageMemory }: { memory: PanelProjectMemory | null; onManageMemory: () => void }) {
  if (memory === null) {
    // Holds the section's place while it loads, so the panel does not grow
    // under the reader's eye when the answer lands.
    return (
      <div className="space-y-2" aria-hidden="true">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
      </div>
    );
  }
  const summary = memory.summary ? summaryExcerpt(memory.summary.content) : "";
  if (!summary && memory.facts.length === 0) {
    return <PanelEmpty description={`What ${PRODUCT_NAME} learns in this project’s chats stays here. Your other chats never see it.`} />;
  }
  return (
    <div className="motion-safe:animate-fade-in">
      {summary && memory.summary && (
        <button
          type="button"
          onClick={onManageMemory}
          className="-mx-2 mb-2 block w-[calc(100%+1rem)] rounded-inner px-2 py-1.5 text-left transition-colors duration-fast ease-out-soft hover:bg-accent"
        >
          <p className="line-clamp-3 text-pretty text-caption text-foreground">{summary}</p>
          <p className="mt-1 text-caption text-muted-foreground">Summary · updated {timeAgo(memory.summary.updatedAt)}</p>
        </button>
      )}
      {memory.facts.length > 0 && (
        <ul className="space-y-1.5">
          {memory.facts.slice(0, MEMORY_PREVIEW).map((fact) => (
            <li key={fact.id} className="flex gap-2 text-caption text-muted-foreground">
              <span aria-hidden="true" className="select-none text-ink-tertiary">
                ·
              </span>
              <span className="min-w-0 flex-1 text-pretty break-words" title={fact.content}>
                {wordExcerpt(fact.content, FACT_CHARS)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {memory.activeCount > Math.min(memory.facts.length, MEMORY_PREVIEW) && (
        <PanelMore onClick={onManageMemory}>View all {memory.activeCount.toLocaleString()} memories</PanelMore>
      )}
    </div>
  );
}

function PanelSection({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const id = React.useId();
  return (
    <section className="px-4 py-3.5" aria-labelledby={id}>
      <div className="flex min-h-7 items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 id={id} className="truncate text-ui font-semibold text-foreground">
            {title}
          </h2>
          {count !== undefined && count > 0 && <span className="text-caption tabular-nums text-muted-foreground">{count.toLocaleString()}</span>}
        </div>
        {action}
      </div>
      <div className="mt-1.5">{children}</div>
    </section>
  );
}

/** A sentence and, where something resolves it, one small button. */
function PanelEmpty({ description, action }: { description: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div>
      <p className="text-pretty text-caption text-muted-foreground">{description}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

function PanelMore({ onClick, open, children }: { onClick: () => void; open?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      className="group/more -mx-2 mt-1 flex w-[calc(100%+1rem)] items-center gap-1.5 rounded-inner px-2 py-1.5 text-left text-caption text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground"
    >
      {children}
      <ArrowRight
        className={cn("size-3 shrink-0 transition-transform duration-base ease-out-expo motion-reduce:transition-none", open ? "-rotate-90" : "group-hover/more:translate-x-0.5")}
        aria-hidden="true"
      />
    </button>
  );
}

function plural(n: number, noun: string) {
  return `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;
}

/** At most `max` characters, ending on a whole word, with the ellipsis set against it. */
export function wordExcerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const span = flat.slice(0, max + 1);
  const space = span.lastIndexOf(" ");
  const head = space > max * 0.6 ? span.slice(0, space) : flat.slice(0, max);
  return `${head.replace(/[\s,.;:!?–—-]+$/u, "")}…`;
}

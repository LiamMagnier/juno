"use client";

import "@/components/projects/projects.css";

import * as React from "react";
import Link from "next/link";
import {
  ArrowRight,
  FileText,
  FileCode,
  FileUp,
  Image as ImageIcon,
  Table,
  Upload,
  Search,
  Loader2,
} from "@/components/ui/icons";
import { ActionIcons, AppIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pressable } from "@/components/ui/pressable";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { EmptyState } from "@/components/ui/empty-state";
import { formatBytes, cn } from "@/lib/utils";
import { staggerDelay } from "@/lib/motion";
import type { ArtifactType } from "@/lib/message-content";
import type { KnowledgeIndexState } from "@/components/library/index-status";
import { ARTIFACT_NOUN, artifactPath } from "@/lib/artifact-links";
import { PRODUCT_NAME } from "@/lib/brand/names";

export interface ProjectFileItem {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  url: string;
  kind: string;
  knowledge?: (KnowledgeIndexState & { documentId: string }) | null;
}

export interface ProjectArtifactItem {
  id: string;
  identifier: string;
  title: string;
  type: string;
  updatedAt: string;
}

interface ProjectSourcesListProps {
  projectId: string;
  files: ProjectFileItem[];
  artifacts?: ProjectArtifactItem[];
  onUploadClick: () => void;
  /** Files dropped on the well. Absent → the well is click-only. */
  onDropFiles?: (files: File[]) => void;
  onDeleteFile?: (fileId: string) => void;
  uploading?: boolean;
  className?: string;
}

type SourceFilter = "all" | "files" | "artifacts";

function getFileIcon(mime: string, kind: string) {
  if (kind === "IMAGE" || mime.startsWith("image/")) return ImageIcon;
  if (mime.includes("json") || mime.includes("javascript") || mime.includes("typescript") || mime.includes("python"))
    return FileCode;
  if (mime.includes("csv") || mime.includes("excel") || mime.includes("spreadsheet")) return Table;
  return FileText;
}

/** queued | extracting | ocr | indexing | ready | degraded | failed | stale */
function indexLabel(state: string | undefined) {
  switch (state) {
    case "ready":
      return { label: "Indexed", tone: "" };
    case "degraded":
      return { label: "Partly indexed", tone: "" };
    case "stale":
      return { label: "Re-indexing", tone: "" };
    case "failed":
      return { label: "Index failed", tone: "text-destructive" };
    case "queued":
    case "extracting":
    case "ocr":
    case "indexing":
      return { label: "Indexing…", tone: "" };
    default:
      return null;
  }
}

export function ProjectSourcesList({
  projectId: _projectId,
  files,
  artifacts = [],
  onUploadClick,
  onDropFiles,
  onDeleteFile,
  uploading = false,
  className,
}: ProjectSourcesListProps) {
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<SourceFilter>("all");
  const [dragging, setDragging] = React.useState(false);
  // Enter/leave fire for every child the pointer crosses; count them so the
  // highlight does not flicker while the cursor moves over the well's text.
  const dragDepth = React.useRef(0);

  const nonCoverFiles = React.useMemo(
    () => files.filter((f) => f.fileName !== "__cover__"),
    [files]
  );

  const filteredFiles = React.useMemo(() => {
    if (!query.trim()) return nonCoverFiles;
    const q = query.toLowerCase();
    return nonCoverFiles.filter((f) => f.fileName.toLowerCase().includes(q));
  }, [nonCoverFiles, query]);

  const filteredArtifacts = React.useMemo(() => {
    if (!query.trim()) return artifacts;
    const q = query.toLowerCase();
    return artifacts.filter((a) => a.title.toLowerCase().includes(q));
  }, [artifacts, query]);

  const showFiles = filter === "all" || filter === "files";
  const showArtifacts = filter === "all" || filter === "artifacts";
  const visibleCount = (showFiles ? filteredFiles.length : 0) + (showArtifacts ? filteredArtifacts.length : 0);
  const total = nonCoverFiles.length + artifacts.length;

  const dropHandlers = onDropFiles
    ? {
        onDragEnter: (e: React.DragEvent) => {
          e.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        },
        onDragOver: (e: React.DragEvent) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        },
        onDragLeave: () => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        },
        onDrop: (e: React.DragEvent) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          const dropped = Array.from(e.dataTransfer.files ?? []);
          if (dropped.length > 0) onDropFiles(dropped);
        },
      }
    : {};

  return (
    <div className={cn("space-y-4", className)}>
      {/* Drop well */}
      <button
        type="button"
        onClick={onUploadClick}
        disabled={uploading}
        aria-label={onDropFiles ? "Drop files here or click to upload" : "Upload files"}
        className={cn(
          // One compact row rather than a 220px slab: the well is an offer,
          // not the page's subject, and the list it fills sits right under it.
          "group flex w-full items-center gap-4 rounded-card border border-dashed border-foreground/[.12] p-1.5 pr-4 text-left transition-[border-color,background-color] duration-fast ease-out-soft hover:border-foreground/25 hover:bg-foreground/[.02] disabled:cursor-progress motion-reduce:transition-none",
          dragging && "border-primary/60 bg-primary/5 hover:border-primary/60 hover:bg-primary/5"
        )}
        {...dropHandlers}
      >
        <span
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-xs border border-foreground/[.08] bg-foreground/[.025] text-muted-foreground transition-colors duration-fast ease-out-soft group-hover:text-foreground motion-reduce:transition-none",
            dragging && "text-primary group-hover:text-primary"
          )}
        >
          {uploading ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <FileUp className="size-4" aria-hidden="true" />
          )}
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-ui font-medium text-foreground">
          {uploading ? "Uploading…" : dragging ? "Drop to add to this project" : onDropFiles ? "Drop files here, or click to browse" : "Click to upload files"}
        </span>
        <span className="text-caption text-muted-foreground">
          {`PDFs, documents, code and data, indexed so ${PRODUCT_NAME} can cite them.`}
        </span>
        </span>
      </button>

      {/* Toolbar */}
      {/* The search fills the row; the filter and Upload sit together on the
          right edge. Under 40rem the search takes its own line. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full @[40rem]/page:w-auto @[40rem]/page:min-w-64 @[40rem]/page:flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files and artifacts…"
            aria-label="Search files and artifacts"
            className="pl-9"
          />
        </div>
        <div className="flex w-full items-center gap-2 @[40rem]/page:w-auto">
        <SegmentedControl
          value={filter}
          onChange={setFilter}
          ariaLabel="Show"
          options={[
            { value: "all", label: "All", count: total },
            { value: "files", label: "Files", count: nonCoverFiles.length },
            { value: "artifacts", label: "Artifacts", count: artifacts.length },
          ]}
        />
        <Button
          type="button"
          variant="secondary"
          onClick={onUploadClick}
          loading={uploading}
          className="ml-auto"
        >
          <Upload className="size-4" aria-hidden="true" />
          Upload
        </Button>
        </div>
      </div>

      {visibleCount === 0 ? (
        <EmptyState
          size="panel"
          className="motion-safe:animate-rise-in"
          icon={query ? Search : FileText}
          title={query ? "No matching sources" : filter === "artifacts" ? "No artifacts yet" : "No files yet"}
          description={
            query
              ? "Try another search term."
              : filter === "artifacts"
                ? `Artifacts ${PRODUCT_NAME} builds in this project’s chats will collect here.`
                : "Add PDFs, documents, code or data to ground every answer in this project."
          }
          action={
            query ? (
              <Button variant="ghost" size="sm" onClick={() => setQuery("")} className="text-muted-foreground">
                Clear search
              </Button>
            ) : undefined
          }
        />
      ) : (
        // `-mx-3`: rows keep their hover inset, their marks sit on the column edge.
        <div className="-mx-3 space-y-6">
          {showFiles && filteredFiles.length > 0 && (
            <section aria-label="Files">
              <p className="pj-annot mb-1 flex items-center gap-2 px-3">
                Files
                <span className="text-muted-foreground/70">{filteredFiles.length}</span>
              </p>
              <ul className="space-y-px">
                {filteredFiles.map((file, i) => {
                  const Icon = getFileIcon(file.mimeType, file.kind);
                  const status = indexLabel(file.knowledge?.state);
                  return (
                    <li
                      key={file.id}
                      className="group flex w-full items-center gap-3 rounded-field p-1.5 pr-3 text-left transition-colors duration-fast ease-out-soft hover:bg-accent motion-reduce:transition-none [animation-fill-mode:backwards] motion-safe:animate-rise-in"
                      style={staggerDelay(i, "tight")}
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-sm border border-foreground/[.08] bg-foreground/[.025] text-muted-foreground transition-colors duration-fast ease-out-soft group-hover:text-foreground motion-reduce:transition-none">
                        <Icon className="size-4" aria-hidden="true" />
                      </span>
                      <a
                        href={file.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-xs"
                      >
                        <span className="truncate text-ui font-medium text-foreground">{file.fileName}</span>
                        <span className="pj-annot flex items-center gap-2">
                          <span>{formatBytes(file.size)}</span>
                          {/* The state in words, no coloured pip (no status dots). */}
                          {status && <span className={status.tone || undefined}>· {status.label}</span>}
                        </span>
                      </a>

                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-fast ease-out-soft focus-within:opacity-100 group-hover:opacity-100 coarse:opacity-100 motion-reduce:transition-none">
                        <Pressable kind="icon" size="sm" asChild aria-label={`Download ${file.fileName}`}>
                          <a href={file.url} target="_blank" rel="noopener noreferrer" download title="Download">
                            <ActionIcons.download className="size-3.5" aria-hidden="true" />
                          </a>
                        </Pressable>
                        {onDeleteFile && (
                          <Pressable
                            kind="icon"
                            size="sm"
                            onClick={() => onDeleteFile(file.id)}
                            aria-label={`Remove ${file.fileName}`}
                            title="Remove"
                            className="danger-hover"
                          >
                            <ActionIcons.delete className="size-3.5" aria-hidden="true" />
                          </Pressable>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {showArtifacts && filteredArtifacts.length > 0 && (
            <section aria-label="Artifacts">
              <p className="pj-annot mb-1 flex items-center gap-2 px-3">
                Artifacts
                <span className="text-muted-foreground/70">{filteredArtifacts.length}</span>
              </p>
              <ul className="space-y-px">
                {filteredArtifacts.map((art, i) => (
                  <li
                    key={art.id}
                    className="[animation-fill-mode:backwards] motion-safe:animate-rise-in"
                    style={staggerDelay(i, "tight")}
                  >
                    {/* The artifact's own address. This was `/artifacts?id=`,
                        which nothing reads, so every row opened the whole
                        Artifacts list and left the reader to find the one
                        they had clicked (L27). */}
                    <Link
                      href={artifactPath(art.id)}
                      className="group flex w-full items-center gap-3 rounded-field p-1.5 pr-3 text-left transition-colors duration-fast ease-out-soft hover:bg-accent motion-reduce:transition-none"
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-sm border border-foreground/[.08] bg-foreground/[.025] text-muted-foreground transition-colors duration-fast ease-out-soft group-hover:text-foreground motion-reduce:transition-none">
                        <AppIcons.artifacts className="size-4" aria-hidden="true" />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-ui font-medium text-foreground">{art.title}</span>
                        <span className="text-caption text-muted-foreground">
                          {ARTIFACT_NOUN[art.type as ArtifactType] ?? art.type}
                        </span>
                      </span>
                      {/* An arrow, not the leaves-Juno mark: this row opens the
                          artifact inside the product. It fades in and nudges
                          the way the row goes. */}
                      <ArrowRight
                        className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-fast ease-out-soft group-hover:opacity-100 group-focus-visible:opacity-100 coarse:opacity-100 motion-reduce:transition-none"
                        aria-hidden="true"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

"use client";

import * as React from "react";
import Link from "next/link";
import {
  FileText,
  FileCode,
  FileUp,
  Image as ImageIcon,
  Table,
  Upload,
  Search,
  ExternalLink,
  Boxes,
  Loader2,
  Download,
} from "lucide-react";
import { ActionIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pressable } from "@/components/ui/pressable";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { EmptyState } from "@/components/ui/empty-state";
import { formatBytes, cn } from "@/lib/utils";
import { staggerDelay } from "@/lib/motion";
import type { KnowledgeIndexState } from "@/components/library/index-status";

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
      return { label: "Indexed", pip: "bg-success" };
    case "degraded":
      return { label: "Partly indexed", pip: "bg-warning" };
    case "stale":
      return { label: "Re-indexing", pip: "bg-warning" };
    case "failed":
      return { label: "Index failed", pip: "bg-destructive" };
    case "queued":
    case "extracting":
    case "ocr":
    case "indexing":
      return { label: "Indexing…", pip: "bg-warning" };
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
          "surface-inset flex w-full flex-col items-center justify-center gap-2 rounded-card border-dashed border-border/80 p-8 text-center transition-[border-color,background-color,color] duration-fast ease-out-soft hover:border-foreground/30 disabled:cursor-progress motion-reduce:transition-none",
          dragging && "border-primary/60 bg-primary/5"
        )}
        {...dropHandlers}
      >
        <span
          className={cn(
            "surface-raised flex size-10 items-center justify-center rounded-field text-muted-foreground",
            dragging && "text-primary"
          )}
        >
          {uploading ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <FileUp className="size-4" aria-hidden="true" />
          )}
        </span>
        <span className="text-sm font-medium text-foreground">
          {uploading ? "Uploading…" : dragging ? "Drop to add to this project" : onDropFiles ? "Drop files here, or click to browse" : "Click to upload files"}
        </span>
        <span className="font-mono text-caption text-muted-foreground">
          PDFs, documents, code and data — indexed so Juno can cite them.
        </span>
      </button>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
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
          size="sm"
          variant="secondary"
          onClick={onUploadClick}
          disabled={uploading}
          className="ml-auto gap-1.5"
        >
          {uploading ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Upload className="size-3.5" aria-hidden="true" />
          )}
          {uploading ? "Uploading…" : "Upload"}
        </Button>
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
                ? "Artifacts Juno builds in this project’s chats will collect here."
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
        <div className="space-y-6">
          {showFiles && filteredFiles.length > 0 && (
            <section aria-label="Files">
              <p className="mb-1.5 px-3 font-mono text-label text-muted-foreground">
                Files · {filteredFiles.length}
              </p>
              <ul className="space-y-1">
                {filteredFiles.map((file, i) => {
                  const Icon = getFileIcon(file.mimeType, file.kind);
                  const status = indexLabel(file.knowledge?.state);
                  return (
                    <li
                      key={file.id}
                      className="group flex w-full items-center gap-3 rounded-control border border-transparent px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow] duration-fast ease-out-soft hover:border-border/60 hover:bg-card hover:shadow-raised motion-reduce:transition-none [animation-fill-mode:backwards] motion-safe:animate-rise-in"
                      style={staggerDelay(i)}
                    >
                      <span className="surface-inset flex size-9 shrink-0 items-center justify-center rounded-field text-muted-foreground">
                        <Icon className="size-4" aria-hidden="true" />
                      </span>
                      <a
                        href={file.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-xs"
                      >
                        <span className="truncate text-sm font-medium text-foreground">{file.fileName}</span>
                        <span className="flex items-center gap-2 font-mono text-caption tabular-nums text-muted-foreground">
                          <span>{formatBytes(file.size)}</span>
                          {status && (
                            <span className="inline-flex items-center gap-1.5">
                              <span className={cn("size-2 rounded-full", status.pip)} aria-hidden="true" />
                              {status.label}
                            </span>
                          )}
                        </span>
                      </a>

                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-fast ease-out-soft focus-within:opacity-100 group-hover:opacity-100 coarse:opacity-100 motion-reduce:transition-none">
                        <Pressable kind="icon" size="sm" asChild aria-label={`Download ${file.fileName}`}>
                          <a href={file.url} target="_blank" rel="noopener noreferrer" download>
                            <Download className="size-3.5" aria-hidden="true" />
                          </a>
                        </Pressable>
                        {onDeleteFile && (
                          <Pressable
                            kind="icon"
                            size="sm"
                            onClick={() => onDeleteFile(file.id)}
                            aria-label={`Remove ${file.fileName}`}
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
              <p className="mb-1.5 px-3 font-mono text-label text-muted-foreground">
                Artifacts · {filteredArtifacts.length}
              </p>
              <ul className="space-y-1">
                {filteredArtifacts.map((art, i) => (
                  <li
                    key={art.id}
                    className="[animation-fill-mode:backwards] motion-safe:animate-rise-in"
                    style={staggerDelay(i)}
                  >
                    <Link
                      href={`/artifacts?id=${art.identifier}`}
                      className="group flex w-full items-center gap-3 rounded-control border border-transparent px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow] duration-fast ease-out-soft hover:border-border/60 hover:bg-card hover:shadow-raised motion-reduce:transition-none"
                    >
                      <span className="surface-inset flex size-9 shrink-0 items-center justify-center rounded-field text-muted-foreground">
                        <Boxes className="size-4" aria-hidden="true" />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-sm font-medium text-foreground">{art.title}</span>
                        <span className="font-mono text-caption text-muted-foreground">{art.type}</span>
                      </span>
                      <ExternalLink
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

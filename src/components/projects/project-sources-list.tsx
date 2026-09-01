"use client";

import * as React from "react";
import Link from "next/link";
import {
  FileText,
  FileCode,
  Image as ImageIcon,
  Table,
  Upload,
  Search,
  Trash2,
  ExternalLink,
  Boxes,
  CheckCircle2,
  Loader2,
  Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { formatBytes, cn } from "@/lib/utils";
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
  onDeleteFile?: (fileId: string) => void;
  uploading?: boolean;
  className?: string;
}

function getFileIcon(mime: string, kind: string) {
  if (kind === "IMAGE" || mime.startsWith("image/")) return ImageIcon;
  if (mime.includes("json") || mime.includes("javascript") || mime.includes("typescript") || mime.includes("python"))
    return FileCode;
  if (mime.includes("csv") || mime.includes("excel") || mime.includes("spreadsheet")) return Table;
  return FileText;
}

export function ProjectSourcesList({
  projectId: _projectId,
  files,
  artifacts = [],
  onUploadClick,
  onDeleteFile,
  uploading = false,
  className,
}: ProjectSourcesListProps) {
  const [query, setQuery] = React.useState("");
  const [activeSubTab, setActiveSubTab] = React.useState<"all" | "files" | "artifacts">("all");

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

  const showFiles = activeSubTab === "all" || activeSubTab === "files";
  const showArtifacts = activeSubTab === "all" || activeSubTab === "artifacts";

  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-1 min-w-[240px] max-w-md">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search files and artifacts…"
              className="pl-8 h-8 text-ui font-mono bg-secondary/50"
            />
          </div>

          <div className="flex rounded-lg border border-border/60 bg-secondary/40 p-0.5 text-micro font-mono">
            <button
              type="button"
              onClick={() => setActiveSubTab("all")}
              className={cn(
                "rounded-md px-2 py-1 transition-colors",
                activeSubTab === "all" ? "bg-card text-foreground font-semibold shadow-soft" : "text-muted-foreground hover:text-foreground"
              )}
            >
              All ({nonCoverFiles.length + artifacts.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveSubTab("files")}
              className={cn(
                "rounded-md px-2 py-1 transition-colors",
                activeSubTab === "files" ? "bg-card text-foreground font-semibold shadow-soft" : "text-muted-foreground hover:text-foreground"
              )}
            >
              Files ({nonCoverFiles.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveSubTab("artifacts")}
              className={cn(
                "rounded-md px-2 py-1 transition-colors",
                activeSubTab === "artifacts" ? "bg-card text-foreground font-semibold shadow-soft" : "text-muted-foreground hover:text-foreground"
              )}
            >
              Artifacts ({artifacts.length})
            </button>
          </div>
        </div>

        <Button
          type="button"
          size="sm"
          onClick={onUploadClick}
          disabled={uploading}
          className="h-8 gap-1.5 font-mono text-caption"
        >
          {uploading ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              <span>Uploading…</span>
            </>
          ) : (
            <>
              <Upload className="size-3.5" />
              <span>Upload sources</span>
            </>
          )}
        </Button>
      </div>

      {filteredFiles.length === 0 && filteredArtifacts.length === 0 ? (
        <EmptyState
          size="panel"
          className="motion-safe:animate-rise-in py-8"
          icon={FileText}
          title={query ? "No matching sources" : "No files or artifacts yet"}
          description={
            query
              ? "Try adjusting your search keyword."
              : "Upload documents, code, PDFs, or data sheets. The model indexes them to ground its reasoning."
          }
        />
      ) : (
        <div className="space-y-4">
          {/* Files Section */}
          {showFiles && filteredFiles.length > 0 && (
            <div className="space-y-2">
              <span className="font-mono text-micro text-muted-foreground uppercase tracking-wider px-1">
                Knowledge Files ({filteredFiles.length})
              </span>
              <div className="grid gap-2 sm:grid-cols-2">
                {filteredFiles.map((file) => {
                  const Icon = getFileIcon(file.mimeType, file.kind);
                  const isIndexed = file.knowledge?.state === "ready";

                  return (
                    <div
                      key={file.id}
                      className="group flex items-center justify-between gap-3 rounded-card border border-border/70 bg-card p-3 transition-all duration-fast hover:border-border hover:shadow-soft"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-xs bg-secondary text-muted-foreground group-hover:text-primary transition-colors">
                          <Icon className="size-4" />
                        </div>
                        <div className="min-w-0">
                          <p className="truncate font-mono text-ui font-medium text-foreground">
                            {file.fileName}
                          </p>
                          <div className="flex items-center gap-2 font-mono text-micro text-muted-foreground">
                            <span>{formatBytes(file.size)}</span>
                            {isIndexed && (
                              <span className="inline-flex items-center gap-0.5 text-success-ink">
                                <CheckCircle2 className="size-2.5" /> Indexed
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          asChild
                          className="size-7 text-muted-foreground hover:text-foreground"
                          aria-label="Download file"
                        >
                          <a href={file.url} target="_blank" rel="noopener noreferrer" download>
                            <Download className="size-3.5" />
                          </a>
                        </Button>

                        {onDeleteFile && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => onDeleteFile(file.id)}
                            className="size-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                            aria-label="Delete file"
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Artifacts Section */}
          {showArtifacts && filteredArtifacts.length > 0 && (
            <div className="space-y-2">
              <span className="font-mono text-micro text-muted-foreground uppercase tracking-wider px-1">
                Generated Artifacts ({filteredArtifacts.length})
              </span>
              <div className="grid gap-2 sm:grid-cols-2">
                {filteredArtifacts.map((art) => (
                  <Link
                    key={art.id}
                    href={`/artifacts?id=${art.identifier}`}
                    className="group flex items-center justify-between gap-3 rounded-card border border-border/70 bg-card p-3 transition-all duration-fast hover:border-primary/40 hover:shadow-soft"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-xs bg-primary/10 text-primary">
                        <Boxes className="size-4" />
                      </div>
                      <div className="min-w-0">
                        <p className="truncate font-mono text-ui font-medium text-foreground group-hover:text-primary transition-colors">
                          {art.title}
                        </p>
                        <span className="font-mono text-micro text-muted-foreground">
                          {art.type}
                        </span>
                      </div>
                    </div>

                    <ExternalLink className="size-3.5 text-muted-foreground group-hover:text-primary shrink-0 transition-colors" />
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

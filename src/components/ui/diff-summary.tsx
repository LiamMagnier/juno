"use client";

import * as React from "react";
import { ChevronDown, ChevronRight, FileCode, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export interface FileDiffItem {
  path: string;
  additions: number;
  deletions: number;
  status?: "modified" | "added" | "deleted" | "renamed";
  patch?: string;
}

interface DiffSummaryProps {
  files: FileDiffItem[];
  totalAdditions?: number;
  totalDeletions?: number;
  defaultExpanded?: boolean;
  className?: string;
}

export function DiffSummary({
  files,
  totalAdditions,
  totalDeletions,
  defaultExpanded: _defaultExpanded = false,
  className,
}: DiffSummaryProps) {
  const [expandedFile, setExpandedFile] = React.useState<string | null>(
    files.length === 1 ? files[0].path : null
  );
  const [copiedFile, setCopiedFile] = React.useState<string | null>(null);

  const calculatedAdditions =
    totalAdditions ?? files.reduce((acc, f) => acc + (f.additions || 0), 0);
  const calculatedDeletions =
    totalDeletions ?? files.reduce((acc, f) => acc + (f.deletions || 0), 0);

  const copyPatch = (path: string, patch?: string) => {
    if (!patch) return;
    navigator.clipboard.writeText(patch);
    setCopiedFile(path);
    toast.success("Diff copied to clipboard");
    setTimeout(() => setCopiedFile(null), 2000);
  };

  if (!files || files.length === 0) {
    return (
      <div className={cn("rounded-card border border-border/70 bg-card p-4 text-center font-mono text-caption text-muted-foreground", className)}>
        No files changed
      </div>
    );
  }

  return (
    <div className={cn("rounded-card border border-border/80 bg-card shadow-soft overflow-hidden", className)}>
      {/* Diff Header */}
      <div className="flex items-center justify-between border-b border-border/60 bg-secondary/50 px-3.5 py-2.5">
        <div className="flex items-center gap-2 font-mono text-ui font-medium">
          <FileCode className="size-4 text-muted-foreground" />
          <span>
            {files.length} changed file{files.length > 1 ? "s" : ""}
          </span>
        </div>

        <div className="flex items-center gap-2 font-mono text-caption font-semibold">
          <span className="text-success-ink">+{calculatedAdditions}</span>
          <span className="text-destructive-ink">-{calculatedDeletions}</span>
        </div>
      </div>

      {/* File List */}
      <div className="divide-y divide-border/50">
        {files.map((file) => {
          const isExpanded = expandedFile === file.path;
          const hasPatch = Boolean(file.patch);

          return (
            <div key={file.path} className="group/file">
              <div
                className={cn(
                  "flex items-center justify-between gap-3 px-3.5 py-2 transition-colors hover:bg-accent/40 cursor-pointer",
                  isExpanded && "bg-accent/20"
                )}
                onClick={() => {
                  if (hasPatch) {
                    setExpandedFile(isExpanded ? null : file.path);
                  }
                }}
              >
                <div className="flex min-w-0 items-center gap-2">
                  {hasPatch ? (
                    isExpanded ? (
                      <ChevronDown className="size-3.5 text-muted-foreground shrink-0" />
                    ) : (
                      <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
                    )
                  ) : (
                    <span className="size-3.5 shrink-0" />
                  )}

                  <span className="truncate font-mono text-ui text-foreground group-hover/file:text-primary transition-colors">
                    {file.path}
                  </span>

                  {file.status && file.status !== "modified" && (
                    <span
                      className={cn(
                        "rounded-sm px-1.5 py-0.2 font-mono text-micro",
                        file.status === "added" && "bg-success/15 text-success-ink",
                        file.status === "deleted" && "bg-destructive/15 text-destructive-ink",
                        file.status === "renamed" && "bg-warning/15 text-warning-foreground"
                      )}
                    >
                      {file.status}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0 font-mono text-caption">
                  <span className="text-success-ink">+{file.additions}</span>
                  <span className="text-destructive-ink">-{file.deletions}</span>
                </div>
              </div>

              {/* Collapsible Unified Patch Block */}
              {isExpanded && file.patch && (
                <div className="relative border-t border-border/60 bg-muted/30 p-3">
                  <div className="absolute right-3 top-3">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1 px-2 text-micro font-mono"
                      onClick={(e) => {
                        e.stopPropagation();
                        copyPatch(file.path, file.patch);
                      }}
                    >
                      {copiedFile === file.path ? (
                        <>
                          <Check className="size-3 text-success-ink" /> Copied
                        </>
                      ) : (
                        <>
                          <Copy className="size-3" /> Copy diff
                        </>
                      )}
                    </Button>
                  </div>

                  <pre className="max-h-80 overflow-x-auto font-mono text-caption leading-relaxed whitespace-pre font-normal text-foreground/90 select-text">
                    {file.patch.split("\n").map((line, i) => {
                      const isAdd = line.startsWith("+") && !line.startsWith("+++");
                      const isDel = line.startsWith("-") && !line.startsWith("---");
                      const isHunk = line.startsWith("@@");

                      return (
                        <div
                          key={i}
                          className={cn(
                            "px-2 py-0.5 rounded-xs",
                            isAdd && "bg-success/15 text-success-ink",
                            isDel && "bg-destructive/15 text-destructive-ink",
                            isHunk && "text-muted-foreground/70 bg-secondary/60"
                          )}
                        >
                          {line}
                        </div>
                      );
                    })}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

"use client";

import * as React from "react";
import { ChevronRight, FileCode, Copy, Check } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { IconSwap } from "@/components/ui/icon-swap";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export interface FileDiffItem {
  path: string;
  additions: number;
  deletions: number;
  status?: "modified" | "added" | "deleted" | "renamed";
  patch?: string;
}

/** How long "Copied" holds before the check turns back into copy. */
const COPIED_REVERT_MS = 1500;

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
  // The check reverts to copy on the house beat (ICONS_AND_MOTION.md §2.2,
  // rule 7). One timer, restarted by a second copy and cleared on unmount, so
  // a revert never lands on a list that has gone.
  const copiedTimer = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    []
  );

  const calculatedAdditions =
    totalAdditions ?? files.reduce((acc, f) => acc + (f.additions || 0), 0);
  const calculatedDeletions =
    totalDeletions ?? files.reduce((acc, f) => acc + (f.deletions || 0), 0);

  const copyPatch = (path: string, patch?: string) => {
    if (!patch) return;
    navigator.clipboard.writeText(patch);
    setCopiedFile(path);
    toast.success("Diff copied to clipboard");
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => {
      copiedTimer.current = null;
      setCopiedFile(null);
    }, COPIED_REVERT_MS);
  };

  const toggleFile = (path: string, isExpanded: boolean) => {
    setExpandedFile(isExpanded ? null : path);
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
                // A row with a patch is a disclosure button: it takes focus,
                // opens on Enter and Space, and says whether it is open. It
                // stays a <div> with the role rather than becoming a <button>
                // because it holds block content (a button may only hold
                // phrasing content). `role="button"` is also one of the
                // selectors that plays its glyphs' hover articulation. A row
                // without a patch opens nothing, so it is plain content.
                role={hasPatch ? "button" : undefined}
                tabIndex={hasPatch ? 0 : undefined}
                aria-expanded={hasPatch ? isExpanded : undefined}
                className={cn(
                  "flex items-center justify-between gap-3 px-3.5 py-2 transition-colors duration-fast ease-out-soft hover:bg-accent/40",
                  // Flush inside the card's `overflow-hidden`, so the focus
                  // outline is drawn inset or its sides are clipped (§2.2 rule 3).
                  hasPatch && "cursor-pointer focus-visible:-outline-offset-2",
                  isExpanded && "bg-accent/20"
                )}
                onClick={() => {
                  if (hasPatch) toggleFile(file.path, isExpanded);
                }}
                onKeyDown={(event) => {
                  if (!hasPatch || event.target !== event.currentTarget) return;
                  if (event.key === "Enter" || event.key === " ") {
                    // Space would otherwise scroll the page.
                    event.preventDefault();
                    toggleFile(file.path, isExpanded);
                  }
                }}
              >
                <div className="flex min-w-0 items-center gap-2">
                  {/* One caret that turns (in-out: both ends are on screen),
                      not two that swap in a frame. */}
                  {hasPatch ? (
                    <ChevronRight
                      className={cn(
                        "size-3.5 shrink-0 text-muted-foreground transition-transform duration-base ease-in-out motion-reduce:transition-none",
                        isExpanded && "rotate-90"
                      )}
                    />
                  ) : (
                    <span className="size-3.5 shrink-0" />
                  )}

                  {/* The path stays in its own ink on hover — the row's tonal
                      fill is the hover; the accent is kept for state. */}
                  <span className="truncate font-mono text-ui text-foreground">
                    {file.path}
                  </span>

                  {file.status && file.status !== "modified" && (
                    <span
                      className={cn(
                        "rounded-sm px-1.5 py-px font-mono text-micro",
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

              {/* Collapsible Unified Patch Block — unfolds under its row. */}
              <Collapse open={isExpanded && Boolean(file.patch)}>
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
                      {/* The glyph cross-fades copy → check in place; the
                          word beside it changes with it. */}
                      <IconSwap
                        swapped={copiedFile === file.path}
                        from={<Copy className="size-3" />}
                        to={<Check className="size-3 text-success-ink" />}
                      />
                      {copiedFile === file.path ? "Copied" : "Copy diff"}
                    </Button>
                  </div>

                  <pre className="max-h-80 overflow-x-auto font-mono text-caption leading-relaxed whitespace-pre font-normal text-foreground/90 select-text">
                    {(file.patch ?? "").split("\n").map((line, i) => {
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
              </Collapse>
            </div>
          );
        })}
      </div>
    </div>
  );
}

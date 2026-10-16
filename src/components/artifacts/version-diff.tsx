"use client";

import * as React from "react";
import { toast } from "sonner";
import { ChevronsUpDown, GitCompare } from "@/components/ui/icons";
import { ActionIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { DesignPoster } from "@/components/artifacts/artifact-preview";
import { Phrase, PhraseWithArgs, formatPhrase } from "@/lib/i18n-phrase";
import { diffLines, diffSegments, diffStats, unifiedDiff, type DiffLine, type DiffSegment } from "@/lib/line-diff";
import { cn } from "@/lib/utils";

/*
 * Two versions of an artifact, compared the way a reader compares them.
 *
 * The artifact page's Compare used to be two raw <pre> blocks side by side,
 * each cut at 20,000 characters, with nothing marking what changed: the
 * reader diffed by eye, and a change past the cut could not be seen at all.
 * This is the canvas's line diff (removed on the destructive tint, added on
 * the success tint, both line-number gutters in full muted ink) over the
 * whole of both versions, with every long unchanged stretch folded behind a
 * "Show N unchanged lines" row, so a one-line fix in a long document reads as
 * one line. The unified diff can be copied, as in the canvas.
 *
 * A design is two pictures instead: its source is the editor's JSON, which a
 * reader never sees by default.
 */

export const VERSION_DIFF_COPY = {
  identical: "No changes",
  identicalNote: "These two versions are the same.",
  show: "Show",
  unchangedLine: "unchanged line",
  unchangedLines: "unchanged lines",
  showMore: "Show the rest of the changes",
  copyDiff: "Copy diff",
  copied: "Diff copied.",
  changesRegion: "Changes between the two versions",
  version: "Version",
  current: "Current",
} as const;

/** Rows drawn before the reader asks for the rest: a whole rewrite of a long file stays responsive. */
const ROW_BUDGET = 2000;

function DiffRow({ line }: { line: DiffLine }) {
  return (
    <div
      className={cn(
        "flex border-l-2",
        line.type === "added"
          ? "border-success bg-success/10"
          : line.type === "removed"
            ? "border-destructive/70 bg-destructive/10 opacity-80"
            : "border-transparent"
      )}
    >
      <span className="w-10 shrink-0 select-none pr-1 text-right tabular-nums text-muted-foreground">{line.aLine ?? ""}</span>
      <span className="w-10 shrink-0 select-none pr-2 text-right tabular-nums text-muted-foreground">{line.bLine ?? ""}</span>
      <span aria-hidden className="w-4 shrink-0 select-none text-muted-foreground">
        {line.type === "added" ? "+" : line.type === "removed" ? "−" : ""}
      </span>
      <span className="whitespace-pre pr-4">{line.text || " "}</span>
    </div>
  );
}

function GapRow({ count, onOpen }: { count: number; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="pressable flex w-full items-center gap-2 border-y border-border/40 bg-muted/40 px-3 py-1 text-left font-sans text-caption text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <ChevronsUpDown className="size-3.5 shrink-0" aria-hidden />
      <PhraseWithArgs
        spec={{ parts: [{ phrase: VERSION_DIFF_COPY.show }, { kind: "count", n: count, one: VERSION_DIFF_COPY.unchangedLine, other: VERSION_DIFF_COPY.unchangedLines }] }}
      />
    </button>
  );
}

/** The line diff of `older` → `newer`, folded to the changes. */
export function VersionLineDiff({
  older,
  newer,
  olderLabel,
  newerLabel,
  className,
}: {
  older: string;
  newer: string;
  /** "v2", "v5": the copied diff's headers and the gutter captions. */
  olderLabel: string;
  newerLabel: string;
  className?: string;
}) {
  const diff = React.useMemo(() => diffLines(older, newer), [older, newer]);
  const stats = React.useMemo(() => diffStats(diff), [diff]);
  const segments = React.useMemo(() => diffSegments(diff), [diff]);
  const [opened, setOpened] = React.useState<ReadonlySet<number>>(() => new Set());
  const [allRows, setAllRows] = React.useState(false);
  React.useEffect(() => {
    setOpened(new Set());
    setAllRows(false);
  }, [older, newer]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(unifiedDiff(older, newer, olderLabel, newerLabel));
      toast.success(formatPhrase(VERSION_DIFF_COPY.copied));
    } catch {
      /* Clipboard refused (permissions, insecure origin): nothing to say beyond the button not confirming. */
    }
  };

  let budget = allRows ? Number.POSITIVE_INFINITY : ROW_BUDGET;
  let clipped = false;
  const rendered: React.ReactNode[] = [];
  segments.forEach((segment: DiffSegment, index) => {
    if (clipped) return;
    const lines = segment.kind === "gap" && !opened.has(index) ? null : segment.lines;
    if (!lines) {
      rendered.push(<GapRow key={`g${index}`} count={segment.lines.length} onOpen={() => setOpened((s) => new Set(s).add(index))} />);
      return;
    }
    for (let k = 0; k < lines.length; k++) {
      if (budget <= 0) {
        clipped = true;
        break;
      }
      budget--;
      rendered.push(<DiffRow key={`${index}:${k}`} line={lines[k]} />);
    }
  });

  return (
    <div className={cn("overflow-hidden rounded-field border border-border/60 bg-card", className)}>
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <GitCompare className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate font-mono text-caption text-muted-foreground">
          {olderLabel} → {newerLabel}
        </span>
        {(stats.added > 0 || stats.removed > 0) && (
          <>
            <span className="font-mono text-caption tabular-nums text-success">+{stats.added}</span>
            <span className="font-mono text-caption tabular-nums text-destructive">−{stats.removed}</span>
          </>
        )}
        <span className="flex-1" />
        {segments.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => void copy()} className="h-7 gap-1.5 px-2 text-caption text-muted-foreground hover:text-foreground coarse:h-9">
            <ActionIcons.copy className="size-3.5" aria-hidden />
            <Phrase text={VERSION_DIFF_COPY.copyDiff} />
          </Button>
        )}
      </div>
      {segments.length === 0 ? (
        <div className="flex flex-col items-center px-4 py-8 text-center">
          <GitCompare className="size-5 text-muted-foreground" aria-hidden />
          <p className="mt-3 text-heading">
            <Phrase text={VERSION_DIFF_COPY.identical} />
          </p>
          <p className="pt-1 text-body text-muted-foreground">
            <Phrase text={VERSION_DIFF_COPY.identicalNote} />
          </p>
        </div>
      ) : (
        <div
          tabIndex={0}
          role="region"
          aria-label={formatPhrase(VERSION_DIFF_COPY.changesRegion)}
          className="max-h-[min(60dvh,36rem)] overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-safe:animate-fade-in"
        >
          <div className="min-w-max py-1 font-mono text-caption leading-relaxed">{rendered}</div>
          {clipped && (
            <div className="border-t border-border/40 px-3 py-2">
              <Button variant="ghost" size="sm" onClick={() => setAllRows(true)} className="h-7 px-2 text-caption">
                <Phrase text={VERSION_DIFF_COPY.showMore} />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Two pictures of a design, older beside newer: its source is never the thing compared. */
export function VersionPosterCompare({
  artifactId,
  olderVersion,
  newerVersion,
  title,
}: {
  artifactId: string;
  olderVersion: number;
  newerVersion: number;
  title: string;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {[olderVersion, newerVersion].map((version, index) => (
        <figure key={version} className="flex flex-col gap-2">
          <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-field border border-border/60 bg-muted/40 p-3">
            <DesignPoster artifactId={artifactId} version={version} alt={`${title}, v${version}`} />
          </div>
          <figcaption className="font-mono text-caption text-muted-foreground">
            <PhraseWithArgs
              spec={
                index === 1
                  ? [{ parts: [{ phrase: VERSION_DIFF_COPY.version }, { kind: "number", value: version }] }, { parts: [{ phrase: VERSION_DIFF_COPY.current }] }]
                  : { parts: [{ phrase: VERSION_DIFF_COPY.version }, { kind: "number", value: version }] }
              }
            />
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

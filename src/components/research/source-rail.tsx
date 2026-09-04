"use client";

import * as React from "react";
import { ExternalLink, Globe } from "lucide-react";
import { SourceFavicon, hostOf, isRenderableSourceUrl } from "@/components/chat/source-chip";
import { cn } from "@/lib/utils";
import type { ResearchSourceView } from "@/components/research/use-research-run";

/**
 * The publishers, displayed as interactive provenance chips.
 *
 * Modeled after ChatGPT Deep Research and Claude Research:
 * - Clear domain identification (e.g. bloomberg.com, nature.com, arxiv.org)
 * - Visual distinction for sources read in full vs leads
 * - Instant external link access
 * - Clickable source count chip that jumps directly into the full sources deck
 */

const RAIL_COPY = {
  more: "more",
  nothingYet: "Harvesting sources from the web…",
  sources: "sources",
  read: "read",
} as const;

/** How many publisher chips to show before condensing. */
const LIMIT = 5;

export function SourceRail({
  sources,
  onOpenSources,
  className,
}: {
  sources: ResearchSourceView[];
  onOpenSources?: () => void;
  className?: string;
}) {
  const publishers = React.useMemo(() => {
    const byHost = new Map<string, { source: ResearchSourceView; read: boolean; count: number }>();
    for (const source of sources) {
      const host = hostOf(source.url);
      if (!host) continue;
      const existing = byHost.get(host);
      if (!existing) {
        byHost.set(host, { source, read: source.read, count: 1 });
      } else {
        existing.count++;
        if (source.read) existing.read = true;
      }
    }
    return [...byHost.values()];
  }, [sources]);

  const readCount = React.useMemo(() => sources.filter((s) => s.read).length, [sources]);

  if (publishers.length === 0) {
    return (
      <div className={cn("flex items-center gap-2 text-xs text-muted-foreground/75", className)}>
        <Globe className="size-3.5 text-primary/70 motion-safe:animate-pulse" />
        <span>{RAIL_COPY.nothingYet}</span>
      </div>
    );
  }

  const shown = publishers.slice(0, LIMIT);
  const hidden = publishers.length - shown.length;

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        {shown.map(({ source, read, count }) => {
          const host = hostOf(source.url);
          const linkable = isRenderableSourceUrl(source.url);

          const chipContent = (
            <>
              <SourceFavicon url={source.url} variant="cluster" className="size-3.5 shrink-0" />
              <span className="max-w-[120px] truncate font-mono text-caption font-medium text-foreground/90 sm:max-w-[150px]">
                {host}
              </span>
              {count > 1 && (
                <span className="text-micro font-mono text-muted-foreground/80">({count})</span>
              )}
              {read ? (
                <span className="size-1.5 shrink-0 rounded-full bg-success/80" title="Read in full" />
              ) : null}
              {linkable && (
                <ExternalLink className="size-2.5 shrink-0 text-muted-foreground/50 transition-colors group-hover/chip:text-primary" />
              )}
            </>
          );

          return linkable ? (
            <a
              key={source.id}
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open ${host}`}
              className={cn(
                "group/chip inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-secondary/50 px-2.5 py-1 text-xs text-foreground transition-all duration-fast",
                "hover:border-primary/40 hover:bg-secondary hover:shadow-2xs",
                !read && "opacity-75"
              )}
            >
              {chipContent}
            </a>
          ) : (
            <span
              key={source.id}
              title={host}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-secondary/40 px-2.5 py-1 text-xs text-muted-foreground",
                !read && "opacity-75"
              )}
            >
              {chipContent}
            </span>
          );
        })}

        {hidden > 0 && (
          <span className="text-caption font-mono text-muted-foreground/80">
            +{hidden} {RAIL_COPY.more}
          </span>
        )}
      </div>

      {onOpenSources ? (
        <button
          type="button"
          onClick={onOpenSources}
          className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/15 active:scale-[0.98]"
        >
          <span>
            {sources.length} {RAIL_COPY.sources} · {readCount} {RAIL_COPY.read}
          </span>
        </button>
      ) : (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-secondary/70 px-2.5 py-1 text-xs font-mono font-medium text-muted-foreground tabular-nums">
          <span>
            {sources.length} {RAIL_COPY.sources} · {readCount} {RAIL_COPY.read}
          </span>
        </span>
      )}
    </div>
  );
}


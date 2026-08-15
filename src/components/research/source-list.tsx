"use client";

import { cn } from "@/lib/utils";
import { SourceFavicon, hostOf, isRenderableSourceUrl } from "@/components/chat/source-chip";
import type { ResearchSourceView } from "@/components/research/use-research-run";

/**
 * Sources as they land, while a run is still gathering.
 *
 * A run that has found nothing yet says so rather than showing an empty box
 * that reads as broken. The read/unread dot matters: a source in this list
 * that the report cannot cite (found, never fetched) is otherwise
 * indistinguishable from one it can.
 *
 * The logo is the thing a reader actually scans this list with — it is how you
 * see at a glance that a run is reading regulators and journals rather than
 * ten content farms, which is most of what makes a research run feel
 * trustworthy while it is still running. It comes from `SourceFavicon`, which
 * loads it from the source's OWN origin rather than a favicon proxy, so the
 * reading list is not handed to a third party.
 */
export function LiveSourceList({
  sources,
  limit = 12,
  className,
}: {
  sources: ResearchSourceView[];
  limit?: number;
  className?: string;
}) {
  const read = sources.filter((source) => source.read).length;
  const hidden = Math.max(0, sources.length - limit);
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-semibold text-foreground">
          {sources.length === 0
            ? "No sources yet"
            : `${sources.length} ${sources.length === 1 ? "source" : "sources"}`}
        </p>
        {/* Found and read are different numbers, and only the read ones can be
            cited. Showing the split is what stops a run that has surfaced forty
            links but read four from reading as forty sources of evidence. */}
        {sources.length > 0 && (
          <p className="shrink-0 font-mono text-micro tabular-nums text-muted-foreground">{read} read</p>
        )}
      </div>
      {sources.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-1">
          {sources.slice(0, limit).map((source) => {
            const linkable = isRenderableSourceUrl(source.url);
            return (
              // Full-strength accent on hover: sibling icon buttons already
              // hover on `bg-accent`, and a discounted copy of the same token
              // makes one gesture produce two different hovers on one panel.
              <li key={source.id} className="flex min-w-0 items-center gap-2 rounded-control px-1.5 py-1 hover:bg-accent">
                <span
                  aria-hidden
                  className={cn("size-1.5 shrink-0 rounded-full", source.read ? "bg-primary" : "bg-border")}
                />
                {/* Dimmed until read, so the list distinguishes evidence from
                    leads at a glance rather than only through the dot. */}
                <SourceFavicon
                  url={source.url}
                  variant="cluster"
                  className={cn("shrink-0", !source.read && "opacity-50")}
                />
                {linkable ? (
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-w-0 truncate text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    title={source.read ? source.title : `${source.title} — found, not read yet`}
                  >
                    {source.title || source.url}
                  </a>
                ) : (
                  // A non-web scheme still gets listed — hiding it would drop a
                  // source the run leaned on — but never becomes an anchor.
                  <span className="min-w-0 truncate text-xs text-muted-foreground" title={source.title}>
                    {source.title || source.url}
                  </span>
                )}
                <span className="hidden max-w-28 shrink-0 truncate font-mono text-micro text-muted-foreground sm:block">
                  {hostOf(source.url)}
                </span>
              </li>
            );
          })}
          {/* The list stops at `limit`, and used to stop silently: a run that
              had gathered eighty sources showed twelve rows under a heading
              saying eighty, so the list looked like the whole of it and the
              gathering looked like it had stalled. */}
          {hidden > 0 && (
            <li className="px-1.5 pt-0.5 font-mono text-micro tabular-nums text-muted-foreground">
              + {hidden} more
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

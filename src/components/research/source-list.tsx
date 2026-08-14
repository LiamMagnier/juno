"use client";

import { cn } from "@/lib/utils";
import { hostOf, isRenderableSourceUrl } from "@/components/chat/source-chip";
import type { ResearchSourceView } from "@/components/research/use-research-run";

/**
 * Sources as they land, while a run is still gathering.
 *
 * A run that has found nothing yet says so rather than showing an empty box
 * that reads as broken. The read/unread dot matters: a source in this list
 * that the report cannot cite (found, never fetched) is otherwise
 * indistinguishable from one it can.
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
  return (
    <div className={className}>
      <p className="text-xs font-semibold text-foreground">
        {sources.length === 0
          ? "No sources yet"
          : `${sources.length} ${sources.length === 1 ? "source" : "sources"}`}
      </p>
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
                  className={cn("h-1.5 w-1.5 shrink-0 rounded-full", source.read ? "bg-primary" : "bg-border")}
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
        </ul>
      )}
    </div>
  );
}

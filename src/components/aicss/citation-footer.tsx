"use client";

import * as React from "react";
import { hostOf, titleOf } from "@/components/chat/source-chip";
import { cn } from "@/lib/utils";
import type { ClientSource } from "@/types/chat";

/**
 * AIcss "Inline Citations" — the reference footer.
 *
 * Only the footer is taken. AIcss's inline marker is a 12px numbered square, and
 * Juno's `SourceChip` is a numbered chip carrying the source's own favicon: a
 * logo names a site faster than an ordinal does, the chip is already what
 * `markdown.tsx`'s citation walk emits, and its favicon is loaded from the
 * source's own origin rather than a proxy for reasons documented there. Swapping
 * it for a square would have cost identification and privacy to gain nothing.
 *
 * What the footer adds is a NAMED list. `SourcesPill` collapses the same sources
 * behind a count, which is right at the end of a long answer; this is the flat
 * form for a place that has room — the panel, and a message short enough that a
 * disclosure would be more clicks than content.
 */

const CiteArrow = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" />
  </svg>
);

export function CitationFooter({
  sources,
  className,
}: {
  /** In citation order — index + 1 is the `[n]` the prose used. */
  sources: ClientSource[];
  className?: string;
}) {
  if (sources.length === 0) return null;
  return (
    <div className={cn("aicss-cite-footer", className)}>
      {sources.map((source, i) => (
        <a
          // A URL can repeat across citations, so position is part of the key —
          // and it is also what the row displays.
          key={`${i}-${source.url}`}
          className="aicss-cite-ref !no-underline"
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span className="aicss-cite-mark">{i + 1}</span>
          <span className="aicss-cite-label">{titleOf(source)}</span>
          <span className="aicss-cite-sep">·</span>
          <span className="aicss-cite-host">{hostOf(source.url)}</span>
          <span className="aicss-cite-arrow">
            <CiteArrow />
          </span>
        </a>
      ))}
    </div>
  );
}

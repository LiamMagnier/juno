"use client";

import * as React from "react";
import { SourceFavicon, hostOf } from "@/components/chat/source-chip";
import { cn } from "@/lib/utils";
import type { ResearchSourceView } from "@/components/research/use-research-run";

/**
 * The publishers, as a single line of marks.
 *
 * A run's most persuasive fact while it is still going is not how many links it
 * has — it is WHOSE. Four regulators and a journal is a different investigation
 * from twelve content farms, and a count cannot tell them apart. So the live
 * surface carries logos rather than a number: one row, newest last, read sources
 * at full strength and unread ones held back, with the count trailing.
 *
 * Deliberately not a list of titles. That is `SourceDeck`, one tab away, and a
 * corpus you can read is a different object from a corpus you can glance at —
 * the failure of the surface this replaces was refusing to choose, and printing
 * eighteen truncated titles in a chat message.
 *
 * The logos come from `SourceFavicon`, which loads each from the source's OWN
 * origin rather than a favicon proxy, so the reading list is never handed to a
 * third party.
 */

/** Composed with a count at runtime; template literals are invisible to the i18n extractor. */
const RAIL_COPY = { more: "more", nothingYet: "Looking for sources" } as const;

/** How many marks before the row stops and counts instead. */
const LIMIT = 9;

export function SourceRail({
  sources,
  className,
}: {
  sources: ResearchSourceView[];
  className?: string;
}) {
  // One mark per publisher, not per URL: eight pages from one site is one
  // witness, and eight identical logos in a row says the opposite.
  const publishers = React.useMemo(() => {
    const byHost = new Map<string, { source: ResearchSourceView; read: boolean }>();
    for (const source of sources) {
      const host = hostOf(source.url);
      if (!host) continue;
      const existing = byHost.get(host);
      // A publisher counts as read once ANY of its pages was read.
      if (!existing) byHost.set(host, { source, read: source.read });
      else if (source.read && !existing.read) byHost.set(host, { source, read: true });
    }
    return [...byHost.values()];
  }, [sources]);

  if (publishers.length === 0) {
    return <p className={cn("text-ui text-muted-foreground/60", className)}>{RAIL_COPY.nothingYet}</p>;
  }

  const shown = publishers.slice(0, LIMIT);
  const hidden = publishers.length - shown.length;

  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <ul className="flex min-w-0 items-center">
        {shown.map(({ source, read }, i) => (
          <li
            key={source.id}
            title={hostOf(source.url)}
            // Overlapped, in reading order, with the newest on top — the
            // stacked-avatar convention, which is how a set of parties is drawn
            // everywhere else in this product.
            className={cn("relative -ml-1.5 first:ml-0", !read && "opacity-45")}
            style={{ zIndex: shown.length - i }}
          >
            <SourceFavicon
              url={source.url}
              variant="cluster"
              className="size-[22px] ring-2 ring-card"
            />
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <span className="shrink-0 text-caption tabular-nums text-muted-foreground">
          +{hidden} {RAIL_COPY.more}
        </span>
      )}
    </div>
  );
}

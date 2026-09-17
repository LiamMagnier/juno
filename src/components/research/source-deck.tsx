"use client";

import * as React from "react";
import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { SourceFavicon, hostOf, isRenderableSourceUrl, titleOf } from "@/components/chat/source-chip";
import type { ResearchSourceView } from "@/components/research/use-research-run";

/**
 * The corpus, as rows you can scan — read first, leads after.
 *
 * Read-versus-lead is said ONCE, by the group heading. Every row used to
 * restate it in a bordered, tinted capsule ("Read" / "Lead") beside the
 * external-link glyph — two trailing marks per row, the second repeating the
 * heading it sat under (PREMIUM_AUDIT rule 6). The glyph is the one trailing
 * mark; a lead's dimmed favicon is the only other thing that differs.
 *
 * Two voices: `ui` for the title, `caption` for everything else. The host,
 * the count and the footer were `micro` in mono, which is the register for
 * machine identifiers, and a publisher's name is prose.
 */

const DECK_COPY = {
  read: "Read sources",
  leads: "Found leads",
  leadsNote: "Discovered, not yet read",
  empty: "No sources yet",
  emptyNote: "Sources appear here as the research finds them.",
  showAll: "Show all",
  showFewer: "Show fewer",
} as const;

/** How many cards a group shows before it asks. Two rows at the common width. */
const PREVIEW = 6;

function SourceCard({ source }: { source: ResearchSourceView }) {
  const linkable = isRenderableSourceUrl(source.url);
  const title = titleOf({ title: source.title, url: source.url, snippet: "" });
  const host = hostOf(source.url);

  const cardContent = (
    <>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <SourceFavicon
            url={source.url}
            variant="list"
            className={cn("size-4 shrink-0 rounded-xs", !source.read && "opacity-60")}
          />
          <span className="truncate text-caption text-muted-foreground">{host}</span>
        </div>

        {linkable && (
          <ExternalLink className="size-3 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-primary" />
        )}
      </div>

      <span className="mt-2 line-clamp-2 text-ui font-medium leading-snug text-foreground transition-colors group-hover:text-primary/95">
        {title}
      </span>

      {(source.sourceType || source.publishedAt) && (
        <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-border/40 pt-1.5 text-caption text-muted-foreground/75">
          {source.sourceType ? (
            <span className="capitalize">{source.sourceType.replace(/_/g, " ")}</span>
          ) : (
            <span />
          )}
          {source.publishedAt && <span>{source.publishedAt.slice(0, 10)}</span>}
        </div>
      )}
    </>
  );

  const shell =
    "group relative flex min-w-0 flex-col justify-between rounded-control px-2 py-4 transition-colors duration-fast hover:bg-secondary/60 motion-reduce:transition-none";

  return linkable ? (
    <a
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className={cn(shell, "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}
    >
      {cardContent}
    </a>
  ) : (
    <div className={shell} title={title}>
      {cardContent}
    </div>
  );
}

function Group({
  heading,
  note,
  sources,
}: {
  heading: string;
  note?: string;
  sources: ResearchSourceView[];
}) {
  const [expanded, setExpanded] = React.useState(false);
  if (sources.length === 0) return null;
  const shown = expanded ? sources : sources.slice(0, PREVIEW);
  const hidden = sources.length - shown.length;

  return (
    <section>
      <div className="flex items-baseline gap-2">
        <h4 className="text-ui font-medium text-foreground">{heading}</h4>
        <span className="text-caption tabular-nums text-muted-foreground">
          {sources.length}
        </span>
        {note && <span className="min-w-0 truncate text-caption text-muted-foreground">{note}</span>}
      </div>
      <div className="mt-2.5 flex flex-col divide-y divide-border">
        {shown.map((source) => (
          <SourceCard key={source.id} source={source} />
        ))}
      </div>
      {(hidden > 0 || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="pressable mt-2 rounded-control px-2 py-1 text-caption font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          {expanded ? DECK_COPY.showFewer : `${DECK_COPY.showAll} (${sources.length})`}
        </button>
      )}
    </section>
  );
}

export function SourceDeck({
  sources,
  className,
}: {
  sources: ResearchSourceView[];
  className?: string;
}) {
  const read = sources.filter((source) => source.read);
  const leads = sources.filter((source) => !source.read);

  if (sources.length === 0) {
    // Two lines on the panel, not a dashed box: this sits inside
    // `.research-surface` (16px radius, 16px padding), where FLAT_UI §6 gives
    // a nested box a radius of zero, and a bordered well is the wrong answer
    // to "nothing here yet" anyway.
    return (
      <div className={cn("text-center", className)}>
        <p className="text-ui font-medium text-foreground">{DECK_COPY.empty}</p>
        <p className="mt-1 text-caption text-muted-foreground">{DECK_COPY.emptyNote}</p>
      </div>
    );
  }

  return (
    <div className={cn("space-y-5", className)}>
      <Group heading={DECK_COPY.read} sources={read} />
      <Group heading={DECK_COPY.leads} note={DECK_COPY.leadsNote} sources={leads} />
    </div>
  );
}

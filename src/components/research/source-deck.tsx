"use client";

import * as React from "react";
import { Check, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { SourceFavicon, hostOf, isRenderableSourceUrl, titleOf } from "@/components/chat/source-chip";
import type { ResearchSourceView } from "@/components/research/use-research-run";

/**
 * The corpus, as cards you can scan — read first, leads after.
 *
 * Designed with modern citation standards (ChatGPT Deep Research & Claude Research):
 * - Clear distinction between sources read in full (cited evidence) and discovered leads
 * - Publisher domain identity and verified badges
 * - Two-line unclamped titles with external source links
 */

const DECK_COPY = {
  read: "Read in full",
  leads: "Found leads",
  leadsNote: "Harvested candidates pending reading",
  empty: "No sources yet",
  emptyNote: "Initial search results land within a few seconds.",
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
          <span className="truncate font-mono text-xs font-semibold text-foreground/90">{host}</span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {source.read ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-success/20 bg-success/15 px-2 py-0.5 text-micro font-medium text-success-ink">
              <Check className="size-2.5 stroke-[2.5]" /> Read
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full border border-border/50 bg-secondary/80 px-2 py-0.5 text-micro font-medium text-muted-foreground">
              Lead
            </span>
          )}
          {linkable && (
            <ExternalLink className="size-3 text-muted-foreground/50 transition-colors group-hover:text-primary" />
          )}
        </div>
      </div>

      <span className="mt-2 line-clamp-2 text-xs sm:text-sm font-medium leading-snug text-foreground transition-colors group-hover:text-primary/95">
        {title}
      </span>

      {(source.sourceType || source.publishedAt) && (
        <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-border/40 pt-1.5 text-micro font-mono text-muted-foreground/75">
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
    "group relative flex min-w-0 flex-col justify-between rounded-card border border-border/60 bg-secondary/30 p-3 transition-all duration-fast hover:border-primary/40 hover:bg-secondary/60 hover:shadow-xs";

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
        <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-mono tabular-nums text-muted-foreground">
          {sources.length}
        </span>
        {note && <span className="min-w-0 truncate text-caption text-muted-foreground">{note}</span>}
      </div>
      <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
        {shown.map((source) => (
          <SourceCard key={source.id} source={source} />
        ))}
      </div>
      {(hidden > 0 || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="pressable mt-2 rounded-control px-2 py-1 text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
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
    return (
      <div className={cn("rounded-card border border-dashed border-border/70 p-6 text-center bg-card/40", className)}>
        <p className="text-sm font-medium text-foreground">{DECK_COPY.empty}</p>
        <p className="mt-1 text-xs text-muted-foreground">{DECK_COPY.emptyNote}</p>
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


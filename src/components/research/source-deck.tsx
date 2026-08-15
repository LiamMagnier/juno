"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { SourceFavicon, hostOf, isRenderableSourceUrl, titleOf } from "@/components/chat/source-chip";
import type { ResearchSourceView } from "@/components/research/use-research-run";

/**
 * The corpus, as cards you can scan — read first, leads after.
 *
 * REPLACES `LiveSourceList`, whose shape was a single-column list of one-line
 * rows: dot, favicon, truncated title, host. Eighteen of those stacked inside a
 * chat message is the "raw dump" failure every teardown of this feature names —
 * Perplexity's source panel, ChatGPT's run sidebar and Gemini's canvas all use a
 * CARD with the logo, the title on two lines and the domain underneath, because
 * a research corpus is scanned by publisher, and a truncated single line hides
 * the publisher behind the headline.
 *
 * The split is the substance, not the styling. Read sources and unread ones are
 * two different things — only a read source can be cited, so only a read source
 * is evidence — and the old list drew that distinction as a 6px dot and a 50%
 * opacity favicon, which is a footnote on the one fact that decides what the
 * report is allowed to say. Here they are separate groups under separate counts,
 * and the unread group is explicitly labelled as leads.
 *
 * A source is never invented into a link: non-http schemes still get a card,
 * because dropping one would understate the corpus the run leaned on, but they
 * never become an anchor.
 */

/**
 * Composed with counts at runtime, so the fixed halves live in a `COPY` const —
 * template literals are invisible to scripts/generate-i18n-catalog.mjs.
 */
const DECK_COPY = {
  read: "Read in full",
  leads: "Found, not read",
  leadsNote: "these could not be cited",
  empty: "No sources yet",
  emptyNote: "The first results land within a few seconds.",
  showAll: "Show all",
  showFewer: "Show fewer",
} as const;

/** How many cards a group shows before it asks. Two rows at the common width. */
const PREVIEW = 6;

function SourceCard({ source }: { source: ResearchSourceView }) {
  const linkable = isRenderableSourceUrl(source.url);
  const title = titleOf({ title: source.title, url: source.url, snippet: "" });
  const body = (
    <>
      <SourceFavicon url={source.url} variant="list" className={cn("mt-px", !source.read && "opacity-60")} />
      <span className="min-w-0 flex-1">
        {/* Two lines, not one truncated one. A research title is the sentence
            that says whether the source is worth opening; clipping it at the
            column width throws away exactly the half that decides. */}
        <span className="line-clamp-2 text-ui font-medium leading-snug text-foreground/90">{title}</span>
        <span className="mt-1 block truncate text-caption text-muted-foreground">{hostOf(source.url)}</span>
      </span>
    </>
  );

  const shell =
    "flex min-w-0 items-start gap-2.5 rounded-field border border-border/50 bg-secondary/40 p-2.5 transition-colors duration-fast ease-out-soft motion-reduce:transition-none";

  return linkable ? (
    <a
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className={cn(
        shell,
        "hover:border-border hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      )}
    >
      {body}
    </a>
  ) : (
    <span className={shell} title={title}>
      {body}
    </span>
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
        <span className="text-caption tabular-nums text-muted-foreground">{sources.length}</span>
        {note && <span className="min-w-0 truncate text-caption text-muted-foreground">{note}</span>}
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {shown.map((source) => (
          <SourceCard key={source.id} source={source} />
        ))}
      </div>
      {/* The list used to stop silently at twelve under a heading saying
          eighty, so the corpus looked like twelve items and the gathering
          looked stalled. It now always says what it is holding back, and the
          holding back is reversible. */}
      {(hidden > 0 || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="pressable mt-2 rounded-control px-1.5 py-1 text-ui text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
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
      <div className={cn("rounded-field border border-dashed border-border/60 p-4 text-center", className)}>
        <p className="text-ui font-medium text-foreground">{DECK_COPY.empty}</p>
        <p className="mt-0.5 text-caption text-muted-foreground">{DECK_COPY.emptyNote}</p>
      </div>
    );
  }

  return (
    <div className={cn("space-y-4", className)}>
      <Group heading={DECK_COPY.read} sources={read} />
      <Group heading={DECK_COPY.leads} note={DECK_COPY.leadsNote} sources={leads} />
    </div>
  );
}

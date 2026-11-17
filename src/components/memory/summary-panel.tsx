"use client";

import * as React from "react";
import { ChevronDown, History, ListChecks } from "@/components/ui/icons";
import { ActionIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Collapse } from "@/components/ui/collapse";
import { Markdown } from "@/components/chat/markdown";
import { GalaxyMark } from "@/components/brand/galaxy-mark";
import { cn } from "@/lib/utils";
import { parseSummarySections, type SummaryData, type SummarySection } from "@/components/memory/memory-model";
import { relativeTime } from "@/components/memory/memory-time";
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * The summary: what Alevr makes of everything it remembers, in a few
 * paragraphs. The one block on the page written to be read top to bottom,
 * so it sits first, on a flat surface with a hairline edge (no shadow: it is
 * in the page's flow, not floating over it).
 *
 * It used to be set as a document of its own: a 13rem margin column naming
 * it, a 21px lead paragraph, and a two-column body. Read beside the list, the
 * page had two typographic systems. Now its prose is set at the page's body
 * size, the opening section in full ink and the rest muted, and it shows its
 * first sections and unfolds the rest in place (never a scroller inside the
 * page).
 *
 * The prompt bar that changes memory in words follows it (`children`), so the
 * prose and the way to correct it are read together.
 */

/** Roughly how much prose shows before "Read the whole summary". */
const PREVIEW_CHARS = 520;

interface SummaryPanelProps {
  summary: SummaryData | null;
  /** Set when the page shows one project's summary rather than the account's. */
  project: { id: string; name: string } | null;
  consolidating: boolean;
  onRebuild: () => void;
  onOpenActivity: () => void;
  /** Facts memory is unsure of or has not heard in months (memory-review.ts). */
  reviewCount?: number;
  onOpenReview?: () => void;
  /** The prompt dock, when the scope has one (the account does; a project does not). */
  children?: React.ReactNode;
}

export function SummaryPanel({
  summary,
  project,
  consolidating,
  onRebuild,
  onOpenActivity,
  reviewCount = 0,
  onOpenReview,
  children,
}: SummaryPanelProps) {
  const sections = React.useMemo(
    () => (summary ? parseSummarySections(summary.content, project ? "About this project" : "About you") : []),
    [summary, project]
  );
  const [expanded, setExpanded] = React.useState(false);

  // The preview is whole sections, never a cut mid-sentence: the first one
  // always, then more while they fit the budget. The rest unfolds in place.
  const previewCount = React.useMemo(() => {
    let used = 0;
    let count = 0;
    for (const section of sections) {
      if (count > 0 && used + section.body.length > PREVIEW_CHARS) break;
      used += section.body.length;
      count++;
    }
    // A single short section left over is not worth a "Read the whole summary".
    const rest = sections.slice(count).reduce((total, section) => total + section.body.length, 0);
    return rest < 160 ? sections.length : count;
  }, [sections]);
  const preview = sections.slice(0, previewCount);
  const rest = sections.slice(previewCount);
  const hasSummary = !!summary && sections.length > 0;

  return (
    <section aria-labelledby="memory-summary-heading">
      <div className="mem-surface rounded-panel px-5 pb-4 pt-4 @[40rem]/page:px-6">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 id="memory-summary-heading" className="flex min-w-0 items-baseline gap-2 text-foreground">
            <span className="mem-title">{project ? "Project summary" : "Summary"}</span>
            {hasSummary && (
              <span className="mem-count text-ui">
                <span>Updated</span> <span>{relativeTime(summary.updatedAt)}</span>
              </span>
            )}
          </h2>
          {/* Ghost buttons, pulled out by their own padding so their words
              line up with the title: left when they wrap under it on a
              phone, right beside it on a wider page. */}
          <div className="-ml-2.5 flex flex-wrap items-center gap-0.5 @[40rem]/page:-mr-2.5 @[40rem]/page:ml-0">
            {reviewCount > 0 && onOpenReview ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" onClick={onOpenReview} className="gap-1.5 px-2.5 text-muted-foreground">
                    <ListChecks className="size-4" aria-hidden="true" />
                    <span>Review</span>
                    <span className="tabular-nums text-foreground">{reviewCount > 99 ? "99+" : reviewCount}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{`Check what ${PRODUCT_NAME} is unsure of, or hasn’t heard in months`}</TooltipContent>
              </Tooltip>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" onClick={onOpenActivity} className="gap-1.5 px-2.5 text-muted-foreground">
                  <History className="size-4" aria-hidden="true" />
                  <span>Activity</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Your edits, and a recap of what changed</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={consolidating}
                  onClick={onRebuild}
                  className="gap-1.5 px-2.5 text-muted-foreground"
                >
                  <ActionIcons.refresh className="size-4" aria-hidden="true" />
                  <span>{hasSummary ? "Rebuild" : "Write summary"}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>{`Rewrite it from everything ${PRODUCT_NAME} remembers`}</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div className="mt-3">
          {hasSummary ? (
            <div key={`${project?.id ?? "account"}:${summary.updatedAt}`} className="motion-safe:animate-fade-in">
              <div className="relative">
                <Sections sections={preview} leadFirst />
                {rest.length > 0 && (
                  <div
                    aria-hidden="true"
                    className={cn(
                      "pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-background to-transparent transition-opacity duration-base ease-out-soft",
                      expanded && "opacity-0"
                    )}
                  />
                )}
              </div>
              {rest.length > 0 && (
                <>
                  <Collapse open={expanded} innerClassName="pt-4">
                    <Sections sections={rest} />
                  </Collapse>
                  <button
                    type="button"
                    onClick={() => setExpanded((open) => !open)}
                    aria-expanded={expanded}
                    className="relative -mx-2 mt-2 inline-flex h-8 items-center gap-1.5 rounded-control px-2 text-ui font-medium text-muted-foreground hit-44 transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground"
                  >
                    {expanded ? <span>Show less</span> : <span>Read the whole summary</span>}
                    <ChevronDown
                      aria-hidden="true"
                      className={cn(
                        "size-4 transition-transform duration-base ease-in-out motion-reduce:transition-none",
                        expanded && "rotate-180"
                      )}
                    />
                  </button>
                </>
              )}
            </div>
          ) : consolidating ? (
            <p role="status" className="flex items-center gap-2.5 pb-1 text-body text-muted-foreground">
              <GalaxyMark phase="working" size={16} />
              {project ? <span>Reading this project’s chats…</span> : <span>Reading your chats and projects…</span>}
            </p>
          ) : project ? (
            <p className="max-w-prose pb-1 text-body text-muted-foreground">
              {`${PRODUCT_NAME} writes this from the chats in this project as you go. Only those chats read it, and they read nothing else ${PRODUCT_NAME} remembers about you.`}
            </p>
          ) : (
            <p className="max-w-prose pb-1 text-body text-muted-foreground">
              {`${PRODUCT_NAME} writes a short summary once it has a few things to go on. Everything it remembers is listed below either way.`}
            </p>
          )}
        </div>
      </div>

      {children && <div className="mt-3">{children}</div>}
    </section>
  );
}

/** The opening section is the one meant to be read first, so it alone is in full ink. */
function Sections({ sections, leadFirst = false }: { sections: SummarySection[]; leadFirst?: boolean }) {
  return (
    <div className="max-w-prose space-y-4">
      {sections.map((section, index) => (
        <section key={section.title}>
          <h3 className="text-ui font-medium text-muted-foreground">{section.title}</h3>
          <Markdown
            content={section.body}
            className={cn("mt-1 text-body [&_p]:m-0", leadFirst && index === 0 ? "text-foreground" : "text-muted-foreground")}
          />
        </section>
      ))}
    </div>
  );
}

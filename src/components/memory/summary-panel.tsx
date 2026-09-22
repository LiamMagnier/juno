"use client";

import * as React from "react";
import { ChevronDown, History } from "@/components/ui/icons";
import { ActionIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Collapse } from "@/components/ui/collapse";
import { Markdown } from "@/components/chat/markdown";
import { ThinkingDots } from "@/components/signature/thinking-dots";
import { cn } from "@/lib/utils";
import { parseSummarySections, type SummaryData, type SummarySection } from "@/components/memory/memory-model";
import { relativeTime } from "@/components/memory/memory-time";

/*
 * The summary: the one raised surface on the page, because it is the one
 * thing on it written to be read top to bottom.
 *
 * NO SCROLLER INSIDE THE PAGE. The summary used to sit in a 34vh inner scroll
 * area with a fade mask, which is a scrolling region inside a scrolling page,
 * and an Expand button opened the same text in a dialog because the box was
 * too small to read it in. Now it shows its opening sections and unfolds the
 * rest in place, under the same fade that says there is more.
 *
 * The prompt bar is the panel's foot (`children`): changing memory in words
 * happens directly under the words being changed. It is inset 8px from the
 * panel's edge, which is exactly what makes its 12px corners concentric with
 * the panel's 20px ones.
 */

/** Roughly how much prose shows before "Show more": about six lines of the reading column. */
const PREVIEW_CHARS = 520;

interface SummaryPanelProps {
  summary: SummaryData | null;
  /** Set when the page shows one project's summary rather than the account's. */
  project: { id: string; name: string } | null;
  consolidating: boolean;
  onRebuild: () => void;
  onOpenActivity: () => void;
  /** The prompt dock, when the scope has one (the account does; a project does not). */
  children?: React.ReactNode;
}

export function SummaryPanel({ summary, project, consolidating, onRebuild, onOpenActivity, children }: SummaryPanelProps) {
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
    // A single short section left over is not worth a "Show more".
    const rest = sections.slice(count).reduce((total, section) => total + section.body.length, 0);
    return rest < 160 ? sections.length : count;
  }, [sections]);
  const preview = sections.slice(0, previewCount);
  const rest = sections.slice(previewCount);

  const hasSummary = !!summary && sections.length > 0;

  return (
    <section aria-labelledby="memory-summary-heading" className="surface-raised @container/summary rounded-panel">
      <div className="px-5 pb-1 pt-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 id="memory-summary-heading" className="mr-auto text-ui font-medium text-muted-foreground">
            {project ? "Project summary" : "Summary"}
          </h2>
          <div className="-mr-2 flex items-center gap-0.5">
            {hasSummary && (
              <span className="mr-1.5 text-caption text-muted-foreground">
                <span>Updated</span> <span>{relativeTime(summary.updatedAt)}</span>
              </span>
            )}
            {/* Labelled where there is room, glyphs with tooltips where there
                is not: on a phone the two labels pushed the row onto a second
                line under a one-word heading. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={consolidating}
                  onClick={onRebuild}
                  aria-label={hasSummary ? "Rebuild the summary" : "Write the summary"}
                  className="gap-1.5 px-2 text-muted-foreground"
                >
                  <ActionIcons.refresh className="size-3.5" aria-hidden="true" />
                  <span className="hidden @[30rem]/summary:inline">{hasSummary ? "Rebuild" : "Write summary"}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Rewrite it from everything Juno remembers</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onOpenActivity}
                  aria-label="Activity"
                  className="gap-1.5 px-2 text-muted-foreground"
                >
                  <History className="size-3.5" aria-hidden="true" />
                  <span className="hidden @[30rem]/summary:inline">Activity</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Your edits and a recap of what changed</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {hasSummary ? (
          // Keyed on the scope and the rebuild, so a new summary (or a different
          // project's) arrives as one piece instead of changing words in place.
          <div key={`${project?.id ?? "account"}:${summary.updatedAt}`} className="pb-3 pt-2 motion-safe:animate-fade-in">
            <div className="relative">
              <Sections sections={preview} />
              {rest.length > 0 && (
                <div
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-card to-transparent transition-opacity duration-base ease-out-soft motion-reduce:transition-none",
                    expanded && "opacity-0"
                  )}
                />
              )}
            </div>
            {rest.length > 0 && (
              <>
                <Collapse open={expanded} innerClassName="pt-5">
                  <Sections sections={rest} />
                </Collapse>
                <button
                  type="button"
                  onClick={() => setExpanded((open) => !open)}
                  aria-expanded={expanded}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-control py-1 text-ui font-medium text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground motion-reduce:transition-none"
                >
                  {expanded ? <span>Show less</span> : <span>Read the whole summary</span>}
                  <ChevronDown
                    aria-hidden="true"
                    className={cn(
                      "size-3.5 transition-transform duration-base ease-in-out motion-reduce:transition-none",
                      expanded && "rotate-180"
                    )}
                  />
                </button>
              </>
            )}
          </div>
        ) : consolidating ? (
          <p role="status" className="flex items-center gap-2.5 pb-4 pt-3 text-body text-muted-foreground">
            <ThinkingDots />
            {project ? <span>Reading this project’s chats…</span> : <span>Reading your chats and projects…</span>}
          </p>
        ) : project ? (
          <p className="max-w-prose pb-4 pt-2 text-body text-muted-foreground">
            Juno writes this from the chats in this project as you go. Only those chats read it, and they read nothing
            else Juno remembers about you.
          </p>
        ) : (
          <p className="max-w-prose pb-4 pt-2 text-body text-muted-foreground">
            Juno writes a short summary of what it knows once it has a few things to go on. Everything it remembers is
            listed below either way.
          </p>
        )}
      </div>

      {children && <div className="p-2 pt-1">{children}</div>}
    </section>
  );
}

function Sections({ sections }: { sections: SummarySection[] }) {
  return (
    <div className="space-y-4">
      {sections.map((section) => (
        <section key={section.title}>
          <h3 className="text-ui font-semibold text-foreground">{section.title}</h3>
          <Markdown content={section.body} className="mt-1 text-body text-foreground" />
        </section>
      ))}
    </div>
  );
}

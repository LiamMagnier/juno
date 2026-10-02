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
import { PRODUCT_NAME } from "@/lib/brand/names";

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
 * happens directly under the words being changed. It is inset 6px from the
 * panel's edge (p-1.5), which makes its 10px corners concentric with the
 * panel's 16px ones.
 */

/** Roughly how much prose shows before "Read the whole summary": about six lines of the reading column. */
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
    // A single short section left over is not worth a "Read the whole summary".
    const rest = sections.slice(count).reduce((total, section) => total + section.body.length, 0);
    return rest < 160 ? sections.length : count;
  }, [sections]);
  const preview = sections.slice(0, previewCount);
  const rest = sections.slice(previewCount);

  const hasSummary = !!summary && sections.length > 0;

  return (
    // Set like the list under it: a 13rem margin column that names the block
    // and holds its controls, and the reading column. The two blocks share one
    // grid line, so the page reads as one document rather than stacked boxes.
    <section aria-labelledby="memory-summary-heading" className="@container/summary">
      <div className="grid gap-x-14 gap-y-5 @[50rem]/summary:grid-cols-[13rem_minmax(0,1fr)]">
        <div className="min-w-0">
          <h2 id="memory-summary-heading" className="mem-h2 text-foreground">
            {project ? "This project" : "Summary"}
          </h2>
          {hasSummary && (
            <p className="mem-annot mt-2">
              <span>Updated</span> <span>{relativeTime(summary.updatedAt)}</span>
            </p>
          )}
          <div className="-ml-2.5 mt-3 flex flex-wrap gap-0.5 @[50rem]/summary:flex-col @[50rem]/summary:items-start">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={consolidating}
                  onClick={onRebuild}
                  className="gap-2 px-2.5 text-muted-foreground"
                >
                  <ActionIcons.refresh className="size-3.5" aria-hidden="true" />
                  <span>{hasSummary ? "Rebuild" : "Write summary"}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>{`Rewrite it from everything ${PRODUCT_NAME} remembers`}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" onClick={onOpenActivity} className="gap-2 px-2.5 text-muted-foreground">
                  <History className="size-3.5" aria-hidden="true" />
                  <span>Activity</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Your edits and a recap of what changed</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div className="min-w-0">
          {hasSummary ? (
            <div key={`${project?.id ?? "account"}:${summary.updatedAt}`} className="motion-safe:animate-fade-in">
              <Lead section={sections[0]} />
              {preview.length > 1 && (
                <div className="relative mt-8">
                  <Sections sections={preview.slice(1)} />
                  {rest.length > 0 && (
                    <div
                      aria-hidden="true"
                      className={cn(
                        "pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background to-transparent transition-opacity duration-base ease-out-soft motion-reduce:transition-none",
                        expanded && "opacity-0"
                      )}
                    />
                  )}
                </div>
              )}
              {rest.length > 0 && (
                <>
                  <Collapse open={expanded} innerClassName="pt-6">
                    <Sections sections={rest} />
                  </Collapse>
                  <button
                    type="button"
                    onClick={() => setExpanded((open) => !open)}
                    aria-expanded={expanded}
                    className="-mx-3 mt-2 inline-flex h-8 items-center gap-1.5 rounded-control px-3 text-ui font-medium text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-muted hover:text-foreground motion-reduce:transition-none"
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
            <p role="status" className="flex items-center gap-2.5 text-body text-muted-foreground">
              <ThinkingDots />
              {project ? <span>Reading this project’s chats…</span> : <span>Reading your chats and projects…</span>}
            </p>
          ) : project ? (
            <p className="mem-lead max-w-[36rem] text-muted-foreground">
              {`${PRODUCT_NAME} writes this from the chats in this project as you go. Only those chats read it, and they read nothing else ${PRODUCT_NAME} remembers about you.`}
            </p>
          ) : (
            <p className="mem-lead max-w-[36rem] text-muted-foreground">
              {`${PRODUCT_NAME} writes a short summary of what it knows once it has a few things to go on. Everything it remembers is listed below either way.`}
            </p>
          )}

          {children && <div className="mt-8">{children}</div>}
        </div>
      </div>
    </section>
  );
}

/** The opening section, set as the page's lead: the one paragraph meant to be read first. */
function Lead({ section }: { section: SummarySection }) {
  return (
    <section>
      <h3 className="mem-annot">{section.title}</h3>
      <Markdown content={section.body} className="mem-lead mt-2 max-w-[40rem] text-foreground [&_p]:m-0" />
    </section>
  );
}

function Sections({ sections }: { sections: SummarySection[] }) {
  // Two columns once the panel is wide enough to set two readable measures:
  // the summary reads like a profile, not one 900px line.
  return (
    <div className="gap-10 @[40rem]/summary:columns-2 [&>section+section]:mt-5">
      {sections.map((section) => (
        <section key={section.title} className="break-inside-avoid">
          <h3 className="text-ui font-medium text-foreground">{section.title}</h3>
          <Markdown content={section.body} className="mt-1.5 text-body text-muted-foreground" />
        </section>
      ))}
    </div>
  );
}

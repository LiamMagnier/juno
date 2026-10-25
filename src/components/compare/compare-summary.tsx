"use client";

import * as React from "react";
import { toast } from "sonner";
import { ChevronDown, Copy, Download, FileText } from "@/components/ui/icons";
import { StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MENU_W } from "@/components/ui/menu-recipe";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  compareReportFileName,
  compareReportToJson,
  compareReportToMarkdown,
  formatCost,
  formatSeconds,
  type CompareReport,
} from "@/lib/compare/report";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * The comparison's verdict strip, between the composer and the panes.
 *
 * Line one says what every model was sent, and that the page checked it
 * (the request fingerprint each pane recorded from the body it posted
 * matches the spec's). That check covers the request as this browser sent
 * it; what each model then ran with is the server's per-pane report, and any
 * difference there is listed below as a difference. Line two is
 * the verdicts, drawn only from measured latency and from costs whose basis
 * is stated: an estimated cost reads "~". Below that, any condition that
 * was NOT the same for every model, because a comparison that silently
 * differs is worse than none. Export writes the same record as Markdown or
 * JSON (src/lib/compare/report.ts), since comparisons are never saved.
 */

function download(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Let the click start the download before the URL goes away.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function Verdict({ label, value, index, title }: { label: string; value: string; index: number; title?: string }) {
  return (
    <li
      // Keyed by the caller on the value, so a new leader fades in rather than swapping in one frame.
      style={staggerDelay(index, "tight")}
      className="flex min-w-0 items-baseline gap-1.5 [animation-fill-mode:backwards] motion-safe:animate-rise-in"
      title={title}
    >
      <span className="ed-annot shrink-0">{label}</span>
      <span className="min-w-0 truncate text-ui tabular-nums text-foreground">{value}</span>
    </li>
  );
}

export function CompareSummary({ report, streaming }: { report: CompareReport; streaming: boolean }) {
  const { summary, input } = report;
  const exportable = !streaming && report.panes.some((pane) => pane.status === "done" || pane.status === "error");

  const warnings: string[] = [];
  if (!report.identicalInput) warnings.push("Not every model was sent the same request. Run the comparison again.");
  if (summary.effortsMatch === false || report.panes.some((pane) => pane.effort.honoured === false)) {
    warnings.push(
      `Thinking effort differs: ${report.panes.map((pane) => `${pane.label} ${pane.effort.label.replace(" (planned)", "")}`).join(" · ")}`
    );
  }
  if (summary.searchApplied === false) {
    const without = report.panes.filter((pane) => pane.webSearch.applied === false).map((pane) => pane.label);
    warnings.push(`${without.join(" and ")} couldn’t search the web, so ${without.length > 1 ? "they" : "it"} answered from what it knows.`);
  }
  for (const late of summary.lateStarts) warnings.push(`${late.label} started ${formatSeconds(late.offsetMs)} later, with the same input.`);
  for (const label of summary.modelChanged) warnings.push(`The server answered with ${label} instead of the model that was asked for.`);

  const verdicts: Array<{ key: string; label: string; value: string; title?: string }> = [];
  // A stopped answer neither finished nor cost what a full one would: say it sat these out.
  const stoppedNote = report.panes.some((pane) => pane.cost.partial) ? " Stopped answers are left out." : "";
  if (summary.fastestFirstOutput) {
    verdicts.push({
      key: `first-${summary.fastestFirstOutput.paneId}`,
      label: "First to answer",
      value: `${summary.fastestFirstOutput.label} · ${formatSeconds(summary.fastestFirstOutput.value)}`,
      title: "Time from sending to the first streamed output, measured in this browser",
    });
  }
  if (summary.fastestFinish) {
    verdicts.push({
      key: `finish-${summary.fastestFinish.paneId}`,
      label: "First to finish",
      value: `${summary.fastestFinish.label} · ${formatSeconds(summary.fastestFinish.value)}`,
      title: `Time from sending to the complete answer, measured in this browser.${stoppedNote}`,
    });
  }
  if (summary.lowestCost) {
    verdicts.push({
      key: `cost-${summary.lowestCost.paneId}`,
      label: "Lowest cost",
      value: `${summary.lowestCost.label} · ${formatCost(summary.lowestCost.value, summary.lowestCost.estimated ? "estimated" : "reported_usage")}`,
      title: `${
        summary.lowestCost.allReported
          ? "Priced from each provider’s reported token usage at list rates."
          : "Some of these costs are estimates (usage not fully reported), marked ~."
      }${stoppedNote}`,
    });
  }
  if (input.webSearch || summary.citations.union > 0) {
    verdicts.push({
      key: "sources",
      label: "Sources",
      value: `${summary.citations.union} · ${summary.citations.sharedByAll.length} shared by all`,
      title: "Distinct pages across every answer, and how many every model cites",
    });
  }

  // What the same-request check covers, and what it does not: it reads the
  // request each pane posted, while the server reports per pane what it ran.
  const inputTip = `${
    report.identicalInput
      ? "This browser sent every model the same prompt, search setting, effort and time zone; only the model differs."
      : "Not every model was sent the same request."
  } The effort and search each model actually ran with are reported by the server on its pane. Answers are not seeded, so a rerun can differ.`;

  const copyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(compareReportToMarkdown(report));
      toast.success("Comparison copied as Markdown");
    } catch {
      toast.error("Couldn’t copy. Download it instead.");
    }
  };

  return (
    <section aria-label="Comparison summary" className="shrink-0 space-y-2 pb-3 motion-safe:animate-rise-in">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <p
              className={cn(
                "flex items-center gap-1.5 text-caption",
                report.identicalInput ? "text-success-ink" : "text-warning-foreground"
              )}
            >
              {report.identicalInput ? (
                <StatusIcons.success aria-hidden="true" className="size-3.5" />
              ) : (
                <StatusIcons.warning aria-hidden="true" className="size-3.5" />
              )}
              {report.identicalInput ? "Same request sent to every model" : "Requests differ"}
              <span className="font-mono text-muted-foreground">#{input.fingerprint.slice(0, 8)}</span>
              {/* The tooltip is hover-only; the same sentence for assistive tech. */}
              <span className="sr-only">. {inputTip}</span>
            </p>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">{inputTip}</TooltipContent>
        </Tooltip>
        <span className="ed-annot">Search {input.webSearch ? "on" : "off"}</span>
        <span className="ed-annot">Effort {input.reasoningEffortLabel.toLowerCase()}</span>

        <div className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!exportable}
                className="group h-8 gap-1.5 px-2 text-label text-muted-foreground hover:text-foreground coarse:h-10"
                aria-label={exportable ? "Export comparison" : "Export comparison (available when every model has finished)"}
              >
                <Download aria-hidden="true" className="size-4" /> Export
                <ChevronDown aria-hidden="true" className="size-3.5 transition-transform duration-base ease-in-out motion-reduce:transition-none group-data-[state=open]:rotate-180" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={MENU_W}>
              <DropdownMenuItem onSelect={() => void copyMarkdown()}>
                <Copy aria-hidden="true" className="size-4" /> Copy as Markdown
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => download(compareReportFileName(report, "md"), compareReportToMarkdown(report), "text/markdown;charset=utf-8")}
              >
                <FileText aria-hidden="true" className="size-4" /> Download Markdown
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => download(compareReportFileName(report, "json"), compareReportToJson(report), "application/json")}
              >
                <Download aria-hidden="true" className="size-4" /> Download JSON
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {verdicts.length > 0 && (
        <ul aria-label="Verdicts" className="flex flex-wrap gap-x-5 gap-y-1">
          {verdicts.map((verdict, index) => (
            <Verdict key={verdict.key} index={index} label={verdict.label} value={verdict.value} title={verdict.title} />
          ))}
        </ul>
      )}

      {warnings.length > 0 && (
        <ul aria-label="Differences between runs" className="space-y-1">
          {warnings.map((warning) => (
            <li key={warning} className="flex items-start gap-1.5 text-caption text-warning-foreground motion-safe:animate-fade-in">
              <StatusIcons.warning aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0">{warning}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

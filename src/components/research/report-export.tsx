"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RESEARCH_COPY } from "@/components/research/copy";
import {
  reportArtifactIdentifier,
  researchMarkdownFile,
  researchPlainMarkdown,
  researchWordFileName,
  type ReportExportInput,
} from "@/components/research/report-export-model";
import { ShareDialog } from "@/components/share/share-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ChevronDown, Download, FileText, Loader2, PanelRightOpen, Printer } from "@/components/ui/icons";
import { IconSwap } from "@/components/ui/icon-swap";
import { MENU_W_WIDE } from "@/components/ui/menu-recipe";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { artifactPath, chatArtifactPath } from "@/lib/artifact-links";
import { requestOpenArtifact } from "@/lib/artifact-events";
import { fileNameFromDisposition } from "@/lib/download-name";
import { formatPhrase, Phrase, usePhrase } from "@/lib/i18n-phrase";
import { readJsonResponse } from "@/lib/artifact-response";
import { setTitleOverride } from "@/lib/title-override";
import { cn } from "@/lib/utils";

/*
 * What a finished report can become (SPEC §9.13, G37): copied, downloaded as
 * Markdown, Word or PDF, opened in the canvas to edit, and published.
 *
 * THE MARKDOWN IS THE RESEARCH LIBRARY'S EXPORT (src/lib/research/export.ts),
 * called directly. It used to arrive through a React context that nothing ever
 * provided, so every download fell back to the raw report: the
 * `<!-- juno:section=… -->` markers still in it, the model's own sources list,
 * no appendix, and a `research-{date}.md` name. Now the file is the report as
 * the reader shows it, `[n]` kept, with front matter and a numbered sources
 * appendix whose numbers are the ones the report cites, named after its title.
 * Copy and Word take the same Markdown without the front matter.
 *
 * Word is built on the server from that Markdown (POST /api/research/{id}/export)
 * with the converter and open-it-again check the artifact export uses. PDF
 * prints the full-screen reader, whose article is the `data-print-document`;
 * while the print dialog is up the tab title (which browsers use as the file
 * name) is the report's title, through the title override.
 *
 * Open in canvas asks the chat on screen to open the report's artifact
 * (`research-report-{runId}`); with no such chat on screen it goes to the
 * run's chat with the canvas open on the report (or, with no chat, to the
 * artifact's own page). Share publishes that artifact through the ordinary
 * publish panel.
 */

export type { ReportExportInput };

const PRINT_TITLE_KEY = "print";

/** Prints the page with the report's title as the tab title (the PDF's default file name). */
export function printReport(title: string): void {
  if (typeof window === "undefined") return;
  const clear = () => {
    setTitleOverride(PRINT_TITLE_KEY, null);
    window.removeEventListener("afterprint", clear);
  };
  setTitleOverride(PRINT_TITLE_KEY, title);
  window.addEventListener("afterprint", clear);
  window.print();
}

function saveBlob(fileName: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const ACTION = "gap-1.5 px-2.5 text-caption";

export function ReportExportButtons({
  input,
  onPdf,
  onLeave,
}: {
  input: ReportExportInput;
  /** PDF: the full-screen reader prints itself; elsewhere this opens it to print. */
  onPdf(): void;
  /** Called before Open in canvas moves the reader elsewhere (the reader closes itself). */
  onLeave?(): void;
}) {
  const router = useRouter();
  const { run } = input;
  const [copied, setCopied] = React.useState(false);
  const [building, setBuilding] = React.useState(false);
  const [sharing, setSharing] = React.useState(false);
  const copiedTimer = React.useRef<number | null>(null);
  React.useEffect(() => () => {
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
  }, []);
  const copyName = usePhrase(RESEARCH_COPY.report.copyName);
  const downloadName = usePhrase(RESEARCH_COPY.report.downloadName);
  const canvasName = usePhrase(RESEARCH_COPY.report.openInCanvasName);
  const shareName = usePhrase(RESEARCH_COPY.report.shareName);
  const artifactId = run.reportArtifactId ?? null;
  const canOpenInCanvas = !!artifactId || !!run.conversationId;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(researchPlainMarkdown(input));
      setCopied(true);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
      toast.success(formatPhrase(RESEARCH_COPY.report.copied));
    } catch {
      toast.error(formatPhrase(RESEARCH_COPY.report.copyFailed));
    }
  };

  const exportMarkdown = () => {
    try {
      const { fileName, markdown } = researchMarkdownFile(input);
      saveBlob(fileName, new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
      toast.success(formatPhrase(RESEARCH_COPY.report.downloaded));
    } catch {
      toast.error(formatPhrase(RESEARCH_COPY.report.downloadFailed));
    }
  };

  const exportWord = async () => {
    if (building) return;
    setBuilding(true);
    try {
      const res = await fetch(`/api/research/${encodeURIComponent(run.id)}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format: "docx", markdown: researchPlainMarkdown(input), title: input.title }),
      });
      if (!res.ok) {
        const failed = await readJsonResponse(res);
        throw new Error(failed.ok ? formatPhrase(RESEARCH_COPY.report.wordFailed) : failed.error);
      }
      const blob = await res.blob();
      saveBlob(fileNameFromDisposition(res.headers.get("Content-Disposition")) ?? researchWordFileName(input), blob);
      toast.success(formatPhrase(RESEARCH_COPY.report.downloaded));
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : formatPhrase(RESEARCH_COPY.report.wordFailed));
    } finally {
      setBuilding(false);
    }
  };

  const openInCanvas = () => {
    onLeave?.();
    // The reader is a modal over the chat: let it close before the canvas opens beside it.
    window.requestAnimationFrame(() => {
      if (requestOpenArtifact(run.conversationId ?? null, reportArtifactIdentifier(run.id))) return;
      // The chat's canvas is where the report can be edited; its own page only reads it.
      if (run.conversationId) router.push(chatArtifactPath(run.conversationId, reportArtifactIdentifier(run.id)));
      else if (artifactId) router.push(artifactPath(artifactId));
    });
  };

  return (
    <div className="flex items-center gap-1 print:hidden">
      <Button variant="ghost" size="sm" onClick={() => void copy()} aria-label={copyName} className={ACTION}>
        <IconSwap
          swapped={copied}
          from={<ActionIcons.copy className="size-3.5" />}
          to={<StatusIcons.success className="size-3.5 text-success" />}
        />
        <span className="hidden sm:inline">
          <Phrase text={RESEARCH_COPY.report.copy} />
        </span>
      </Button>
      {canOpenInCanvas && (
        <Button variant="ghost" size="sm" onClick={openInCanvas} aria-label={canvasName} className={ACTION}>
          <PanelRightOpen className="size-3.5" />
          <span className="hidden md:inline">
            <Phrase text={RESEARCH_COPY.report.openInCanvas} />
          </span>
        </Button>
      )}
      {artifactId && (
        <Button variant="ghost" size="sm" onClick={() => setSharing(true)} aria-label={shareName} className={ACTION}>
          <ActionIcons.share className="size-3.5" />
          <span className="hidden md:inline">
            <Phrase text={RESEARCH_COPY.report.share} />
          </span>
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label={downloadName} className={cn(ACTION, "data-[state=open]:bg-accent")}>
            <IconSwap
              swapped={building}
              from={<Download className="size-3.5" />}
              to={<Loader2 className={cn("size-3.5", building && "motion-safe:animate-spin")} />}
            />
            <span className="hidden sm:inline">
              <Phrase text={RESEARCH_COPY.report.download} />
            </span>
            <ChevronDown className="size-3 text-muted-foreground" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={MENU_W_WIDE}>
          <DropdownMenuItem onSelect={exportMarkdown}>
            <Download className="size-4" aria-hidden />
            <Phrase text={RESEARCH_COPY.report.formatMarkdown} />
          </DropdownMenuItem>
          <DropdownMenuItem disabled={building} onSelect={() => void exportWord()}>
            <FileText className="size-4" aria-hidden />
            <Phrase text={RESEARCH_COPY.report.formatWord} />
          </DropdownMenuItem>
          {/* A frame later, so the menu has left the page before the print snapshot. */}
          <DropdownMenuItem onSelect={() => window.requestAnimationFrame(() => onPdf())}>
            <Printer className="size-4" aria-hidden />
            <Phrase text={RESEARCH_COPY.report.formatPdf} />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {artifactId && <ShareDialog kind="ARTIFACT" artifactId={artifactId} open={sharing} onOpenChange={setSharing} />}
    </div>
  );
}

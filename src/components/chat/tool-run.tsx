"use client";

/**
 * A REAL RUN IN THE TRANSCRIPT: the receipt row, its detail, its files.
 *
 *   [mark]  Running Python                                   ›
 *   ──────────────────────────────────────────────────────────
 *   Ran in Alevr's sandbox: no internet, no access to your Mac
 *   ▸ Python (the program, collapsed)
 *   Output   head … 12.4 KB not shown … tail      Show full output
 *   Exit code 0 · 2.4s
 *   [chart.png] [summary.csv]
 *
 * Every word comes from `@/lib/chat/tool-run` (the Swift twin is
 * `NativeToolRunPresentation`), and the row is the shared `ToolReceiptRow`,
 * so a run reads like every other receipt: a hairline line, no card, no pill,
 * no status dot. Images render as themselves; other files are the same tiles
 * the conversation's uploads use.
 *
 * The live mark sits on THE active row only (MOTION_AND_THINKING.md): one row
 * of a turn, the latest run still working. Every other row is still. Phase
 * changes are announced once through a polite live region; progress lines and
 * the clock never are.
 */

import * as React from "react";
import { AicssCodeBlock } from "@/components/aicss/code-block";
import { ToolRunFiles } from "@/components/chat/tool-run-files";
import { ReceiptGlyph, ToolReceiptRow } from "@/components/chat/tool-receipt";
import { PhaseOrb } from "@/components/effects/phase-orb";
import { Button } from "@/components/ui/button";
import {
  activeRunId,
  runAgainDraft,
  runCanRunAgain,
  runContextLine,
  runExitLine,
  runMarkEventKey,
  runMarkPhase,
  runOmittedNote,
  runProgressNote,
  runReceiptParts,
  type RunMarkPhase,
  type ToolRunStream,
  type ToolRunView,
} from "@/lib/chat/tool-run";
import { receiptIconKind } from "@/lib/chat/tool-receipt";
import type { ClientAttachment } from "@/types/chat";

export { ToolRunAnnouncer, ToolRunFiles, ToolRunOutputs } from "@/components/chat/tool-run-files";

/* ── The mark ───────────────────────────────────────────────────────────── */

/**
 * The live mark beside the one active run row.
 *
 * Same contract as the Continuum `ThinkingMark` (rf/brand-assets,
 * `src/components/brand/thinking-mark.tsx`): a truthful `phase` and an
 * `eventKey` that changes with each real batch of activity. Until that mark
 * reaches the trunk this draws the house orb for `working` and nothing for the
 * still phases (the row's own glyph says waiting, error or stopped), which is
 * the same rule the mark follows: still unless real work is happening.
 * Decorative: the row's words carry the state.
 */
export function RunMark({
  phase,
  eventKey,
}: {
  phase: RunMarkPhase;
  eventKey?: string;
}) {
  if (phase !== "working") return null;
  return (
    <span data-run-mark data-phase={phase} data-event={eventKey} aria-hidden="true" className="contents">
      <PhaseOrb state="working" className="-my-0.5 -ml-0.5" />
    </span>
  );
}

/* ── Detail ─────────────────────────────────────────────────────────────── */

const LANGUAGE_BLOCK_LABEL: Record<NonNullable<ToolRunView["language"]> | "unknown", string> = {
  python: "Python",
  javascript: "JavaScript",
  bash: "Shell script",
  unknown: "Code",
};

function StreamBlock({ label, stream, logUrl }: { label: string; stream: ToolRunStream; logUrl: string | null }) {
  const omitted = runOmittedNote(stream);
  return (
    <div className="mt-2">
      <AicssCodeBlock label={label} code={stream.head} maxBodyHeight={200} className="bg-secondary" />
      {omitted || stream.tail ? (
        <p className="mt-1 flex flex-wrap items-baseline gap-x-2 font-mono text-caption text-muted-foreground">
          {omitted ? <span>{omitted}</span> : null}
          {omitted && logUrl ? (
            <a
              href={logUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-foreground hover:underline motion-reduce:transition-none"
            >
              Show full output
            </a>
          ) : null}
        </p>
      ) : null}
      {stream.tail ? (
        <AicssCodeBlock label={`${label}, end`} code={stream.tail} maxBodyHeight={200} className="mt-1 bg-secondary" />
      ) : null}
    </div>
  );
}

/**
 * Everything a run left behind, in the order a reader checks it: where it ran,
 * what it ran, what it printed, how it ended, what it made.
 */
export function ToolRunDetail({
  view,
  onRunAgain,
  onOpenFile,
}: {
  view: ToolRunView;
  onRunAgain?: (draft: string) => void;
  onOpenFile?: (attachment: ClientAttachment) => void;
}) {
  const context = runContextLine(view);
  const exit = runExitLine(view);
  const live = view.phase === "running" || view.phase === "queued";
  const progressNote = runProgressNote(view.progress);
  const lines = view.progress?.lines ?? [];
  return (
    <div className="min-w-0 pt-0.5">
      {context ? <p className="text-caption text-muted-foreground">{context}</p> : null}
      {view.reason ? <p className="mt-1 text-caption text-foreground/80">{view.reason}</p> : null}

      {view.code ? (
        <AicssCodeBlock
          label={LANGUAGE_BLOCK_LABEL[view.language ?? "unknown"]}
          code={view.code}
          maxBodyHeight={180}
          className="mt-2 bg-secondary"
        />
      ) : null}
      {view.code && view.codeTruncated ? (
        <p className="mt-1 text-caption text-muted-foreground">Shortened for display.</p>
      ) : null}

      {live && lines.length ? (
        // The last lines while it runs. Not a live region: output changes
        // several times a second and a screen reader announcing each line is
        // the noise the phase announcement exists to replace.
        <pre
          tabIndex={0}
          className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-xs border border-border/60 bg-secondary px-2.5 py-2 font-mono text-caption leading-5 text-muted-foreground focus-visible:-outline-offset-2"
        >
          {lines.join("\n")}
        </pre>
      ) : null}
      {live && progressNote ? <p className="mt-1 font-mono text-caption text-muted-foreground">{progressNote}</p> : null}

      {view.stdout ? <StreamBlock label="Output" stream={view.stdout} logUrl={view.logUrl} /> : null}
      {view.stderr ? <StreamBlock label="Errors" stream={view.stderr} logUrl={view.logUrl} /> : null}
      {!view.stdout && !view.stderr && view.detail?.result ? (
        // The run record carries no streams of its own: the result the model
        // read (output head and tail, exit, files) is the evidence, verbatim.
        <div className="mt-2">
          <AicssCodeBlock label="Result" code={view.detail.result} maxBodyHeight={220} className="bg-secondary" />
          {view.detail.resultTruncated && view.detail.resultChars ? (
            <p className="mt-1 font-mono text-caption text-muted-foreground">
              {`First ${view.detail.result.length.toLocaleString()} of ${view.detail.resultChars.toLocaleString()} characters`}
            </p>
          ) : null}
        </div>
      ) : null}

      {exit ? <p className="mt-2 font-mono text-caption tabular-nums text-muted-foreground">{exit}</p> : null}

      <ToolRunFiles files={view.files} onOpen={onOpenFile} className="mt-2.5" />
      {view.filesDiscarded > 0 ? (
        <p className="mt-1.5 text-caption text-muted-foreground">
          {view.filesDiscarded === 1 ? "1 file from this run was not kept." : `${view.filesDiscarded} files from this run were not kept.`}
        </p>
      ) : null}

      {onRunAgain && runCanRunAgain(view) ? (
        <div className="mt-2.5 flex gap-1.5">
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => onRunAgain(runAgainDraft(view))}>
            Run again
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/* ── Row ────────────────────────────────────────────────────────────────── */

/**
 * One run as a receipt row with its detail one press away. A failed run opens
 * by default: its stderr is what the reader came for.
 */
export function ToolRunReceipt({
  view,
  active,
  defaultOpen,
  onRunAgain,
  onOpenFile,
}: {
  view: ToolRunView;
  /** THE active row of the turn: the only one that carries the live mark. */
  active: boolean;
  /** Open the detail on first render. A failed run always does. */
  defaultOpen?: boolean;
  onRunAgain?: (draft: string) => void;
  onOpenFile?: (attachment: ClientAttachment) => void;
}) {
  const parts = runReceiptParts(view);
  const [open, setOpen] = React.useState(defaultOpen ?? view.phase === "failed");
  const icon = view.tool === "use_skill" || view.tool === "read_skill_file" ? "skill" : receiptIconKind("run_code");
  const hasDetail =
    !!view.code ||
    !!view.stdout ||
    !!view.stderr ||
    !!view.detail?.result ||
    view.files.length > 0 ||
    !!view.context ||
    (view.progress?.lines.length ?? 0) > 0;
  const mark = parts.status === "running"
    ? active
      ? <RunMark phase={runMarkPhase(view.phase)} eventKey={runMarkEventKey(view)} />
      : <ReceiptGlyph kind={icon} className="size-4 text-muted-foreground" />
    : undefined;
  return (
    <ToolReceiptRow
      icon={icon}
      label={parts.label}
      object={parts.object}
      status={parts.status}
      figure={parts.figure}
      durationMs={parts.durationMs}
      reason={parts.reason}
      expandable={hasDetail}
      open={open}
      onToggle={() => setOpen((value) => !value)}
      mark={mark}
      // Every run label says how it ended ("Python failed", "Stopped"), so the
      // right edge keeps only the evidence: the exit, the files, the time.
      quietStatus
      onRetry={onRunAgain && runCanRunAgain(view) ? () => onRunAgain(runAgainDraft(view)) : undefined}
      retryLabel="Run again"
    >
      {hasDetail ? <ToolRunDetail view={view} onOpenFile={onOpenFile} /> : null}
    </ToolReceiptRow>
  );
}

/** The turn's runs as receipt rows (web Code, Orbit thread rows, the gallery). */
export function ToolRunList({
  views,
  streaming,
  onRunAgain,
  onOpenFile,
}: {
  views: readonly ToolRunView[];
  streaming: boolean;
  onRunAgain?: (draft: string) => void;
  onOpenFile?: (attachment: ClientAttachment) => void;
}) {
  const active = activeRunId(views, streaming);
  return (
    <>
      {views.map((view) => (
        <ToolRunReceipt
          key={view.id}
          view={view}
          active={view.id === active}
          onRunAgain={onRunAgain}
          onOpenFile={onOpenFile}
        />
      ))}
    </>
  );
}

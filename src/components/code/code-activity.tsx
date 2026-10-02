"use client";

import * as React from "react";

import { FileDiff, parseUnifiedDiff } from "@/components/aicss/file-diff";
import {
  FileChangeReceiptRow,
  ToolFailureReceiptRow,
  ToolReceiptList,
  ToolReceiptRow,
} from "@/components/chat/tool-receipt";
import {
  fileChangeFromEvent,
  receiptLabel,
  receiptIconKind,
  type ReceiptStatus,
} from "@/lib/chat/tool-receipt";
import type { CodeActivityEvent } from "@/hooks/use-code-session";
import { codeToolLabel, codeToolStatus } from "@/lib/agent-protocol/code-task-transcript";
import { readToolRun, runReceiptParts } from "@/lib/chat/tool-run";
import { ToolRunReceipt } from "@/components/chat/tool-run";
import type { ClientActivityEvent, ClientMessage } from "@/types/chat";
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * A CODING TRANSCRIPT'S RECEIPTS, IN THE FLOW OF THE TRANSCRIPT.
 *
 * Everything Juno Code does lands here as a RECEIPT ROW: icon, one-line
 * label, right-aligned status/duration, hairline separators. A live row is
 * ONE line ("Editing src/app/page.tsx"); when done it is a compact receipt
 * with the diff or log one press away. Failures are receipts too: one line +
 * reason + Retry when safe.
 *
 * The same anatomy is `DesktopToolCallLine` on macOS and the Code work-log
 * rows on iOS. Keep the three in step.
 */

/** What a tool row reports about how its call ended. */
export type ToolOutcome = "ok" | "failed" | "unknown";

/**
 * How a tool row's call ended, from the producer's typed status — the agent
 * protocol's tool_result, folded by CodeTaskTranscript. This used to be read
 * out of the row's title with regexes (a ` — ok` suffix, a `Denied ` prefix);
 * rows persisted before the status existed are read by the legacy adapter
 * behind `codeToolStatus`, and nowhere here. A call that never ran, or whose
 * end nobody saw, is neither ok nor failed.
 */
export function toolOutcome(event: ClientActivityEvent): ToolOutcome {
  switch (codeToolStatus(event)) {
    case "ok":
      return "ok";
    case "error":
    case "denied":
      return "failed";
    default:
      return "unknown";
  }
}

/** The title to show for a tool row. */
export function toolLabel(event: ClientActivityEvent): string {
  return codeToolLabel(event);
}

/** The exit code as a number, when the row carries one. */
function exitCodeOf(event: ClientActivityEvent): number | null {
  const exit = (event as { exitCode?: unknown }).exitCode;
  return typeof exit === "number" && Number.isFinite(exit) ? exit : null;
}

/**
 * What the run is doing right now, as a sentence about the run.
 *
 * The chat strip's `liveCopy` answers "Thinking" for every
 * Code row, because it recognises tool rows by a prefix Code never writes.
 * This is the Code answer: a command is running, a file is being read or
 * written, an approval is waited on. Null when the row is not one of those,
 * so the caller falls through to whatever it said before.
 */
export function codeLiveCopy(latest: ClientActivityEvent | undefined): string | null {
  if (!latest) return null;
  // A real run speaks the shared run vocabulary ("Running Python", "Waiting
  // for your answer"), the same words chat and Orbit use for it.
  const run = readToolRun(latest, { live: true });
  if (run) return runReceiptParts(run).label;
  if (latest.kind === "tool") {
    const title = toolLabel(latest);
    if (title.startsWith("$ ")) return `Running ${title.slice(2)}`;
    if (title.startsWith("Read ")) return `Reading ${title.slice(5)}`;
    if (title.startsWith("Edit ")) return `Editing ${title.slice(5)}`;
    if (title.startsWith("Write ")) return `Writing ${title.slice(6)}`;
    if (title.startsWith("Glob ") || title.startsWith("Grep ")) return `Searching ${title.slice(5)}`;
    return title;
  }
  if (latest.kind === "write") {
    const change = fileChangeFromEvent(latest);
    return `Writing ${change.path}`;
  }
  if (latest.kind === "warning") return latest.title;
  return null;
}

/** Whether a row is one this renderer draws. Chat-only kinds are skipped. */
function isCodeRow(event: ClientActivityEvent): boolean {
  return event.kind === "tool" || event.kind === "write" || event.kind === "warning" || event.kind === "done";
}

/** Map a Code tool title onto the shared receipt vocabulary's tool id. */
function toolIdFromTitle(label: string): string | undefined {
  if (label.startsWith("$ ")) return "bash";
  if (label.startsWith("Read ")) return "read_file";
  if (label.startsWith("Edit ")) return "edit_file";
  if (label.startsWith("Write ")) return "write_file";
  if (label.startsWith("Glob ")) return "glob";
  if (label.startsWith("Grep ")) return "grep";
  return undefined;
}

/* ── Rows ────────────────────────────────────────────────────────────────── */

/**
 * One command or tool call: `$ npm test`, its exit status, and its output one
 * press away.
 *
 * A failed command opens by default, its output is the thing the reader wants,
 * and everything else stays shut. A live row is ONE line, never a dump.
 */
function ToolRow({ event, live, streaming }: { event: ClientActivityEvent; live: boolean; streaming: boolean }) {
  // A run_code / skill call (lib/chat/tool-run) is a run receipt: its phase,
  // exit, output and files, and the context it ran in from its own record.
  // Read against the TURN's liveness (a stored row that never ended is over),
  // while only the newest row wears the live mark.
  const run = readToolRun(event, { live: streaming });
  if (run) return <ToolRunReceipt view={run} active={live} />;
  return <CommandRow event={event} live={live} />;
}

function CommandRow({ event, live }: { event: ClientActivityEvent; live: boolean }) {
  const label = toolLabel(event);
  const outcome = toolOutcome(event);
  const exit = exitCodeOf(event);
  const detail = event.detail?.trim() ?? "";
  const hasOutput = detail.length > 0;
  const [open, setOpen] = React.useState(outcome === "failed");

  const isCommand = label.startsWith("$ ");
  const toolId = toolIdFromTitle(label);
  const icon = toolId ? receiptIconKind(toolId) : isCommand ? "terminal" : "tools";
  // One-line live copy: "Editing src/app/page.tsx", "Ran npm test".
  const display = isCommand
    ? live
      ? `Running ${label.slice(2)}`
      : `Ran ${label.slice(2)}`
    : live
      ? receiptLabel(toolId, { running: true, object: label.replace(/^(Read|Edit|Write|Glob|Grep) /, "") })
      : label;
  const status: ReceiptStatus =
    live ? "running" : outcome === "ok" ? "ok" : outcome === "failed" ? "failed" : "ok";
  const figure =
    outcome === "failed" && exit !== null && exit !== 0
      ? `exit ${exit}`
      : exit === 0
        ? "exit 0"
        : null;
  const reason =
    outcome === "failed"
      ? (detail.split("\n").find((line) => line.trim())?.slice(0, 160) ??
        (exit !== null && exit !== 0 ? `Exit code ${exit}.` : "Failed."))
      : null;

  return (
    <ToolReceiptRow
      icon={icon}
      label={display}
      status={status}
      figure={figure}
      reason={reason}
      expandable={hasOutput}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      {hasOutput ? (
        <pre
          tabIndex={0}
          className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xs border border-border/60 bg-secondary px-2.5 py-2 font-mono text-caption leading-5 text-muted-foreground focus-visible:-outline-offset-2"
        >
          {detail}
        </pre>
      ) : null}
    </ToolReceiptRow>
  );
}

/**
 * One file the run wrote: a `file_change` receipt with a real diff.
 * A row with no patch is not expandable and shows no chevron: null means
 * "no diff arrived", never "the change was empty".
 */
function WriteRow({ event }: { event: ClientActivityEvent }) {
  const change = fileChangeFromEvent(event);
  const [open, setOpen] = React.useState(false);
  // Parsed on first open and when the patch itself changes, not per render.
  const [opened, setOpened] = React.useState(false);
  const rows = React.useMemo(
    () => (opened && change.patch ? parseUnifiedDiff(change.patch) : null),
    [opened, change.patch],
  );

  return (
    <FileChangeReceiptRow
      change={change}
      open={open}
      onToggle={() => {
        setOpen((v) => !v);
        setOpened(true);
      }}
    >
      {/* Present whenever a patch arrived, so the row opens; the parse waits
          for the first open. */}
      {change.patch ? (
        <div tabIndex={0} className="max-h-72 overflow-auto focus-visible:-outline-offset-2">
          {rows ? <FileDiff file={change.path} rows={rows} /> : null}
        </div>
      ) : null}
    </FileChangeReceiptRow>
  );
}

/** An approval, a denial, a rollback outcome, a stop: the rows that are about
 *  the run rather than about a file or a command. Failures stay receipts. */
function NoteRow({ event }: { event: ClientActivityEvent }) {
  const approval = event.title === "Approval requested";
  const failed = event.kind === "warning";
  if (approval) {
    return (
      <ToolReceiptRow
        icon="warning"
        label="Asked for approval"
        object={event.detail || null}
        status="waiting"
      />
    );
  }
  if (event.kind === "done") {
    return (
      <ToolReceiptRow
        icon="success"
        label={event.title}
        object={event.detail || null}
        status="ok"
      />
    );
  }
  if (failed) {
    return <ToolFailureReceiptRow label={event.title} reason={event.detail || null} />;
  }
  return <ToolReceiptRow icon="warning" label={event.title} object={event.detail || null} status="ok" />;
}

/* ── The list ────────────────────────────────────────────────────────────── */

export function CodeActivity({
  events,
  streaming = false,
  className,
}: {
  events: readonly ClientActivityEvent[];
  /** The run is live: the newest unresolved tool row shows a pulse. */
  streaming?: boolean;
  className?: string;
}) {
  const rows = events.filter(isCodeRow);
  if (rows.length === 0) return null;
  const last = rows[rows.length - 1];
  return (
    <ToolReceiptList label={`What ${PRODUCT_NAME} Code did`} className={className}>
      {rows.map((event) =>
        event.kind === "tool" ? (
          <ToolRow key={event.id} event={event} live={streaming && event === last} streaming={streaming} />
        ) : event.kind === "write" ? (
          <WriteRow key={event.id} event={event} />
        ) : (
          <NoteRow key={event.id} event={event} />
        ),
      )}
    </ToolReceiptList>
  );
}

/**
 * The transcript's Code rows, shaped for `MessageList`'s `inlineRuns`.
 *
 * One node per ASSISTANT turn that has rows to draw, dated at the turn so the
 * list places it directly under that turn. `CodeActivityEvent` is the hook's
 * row type; the persisted rows arrive as plain `ClientActivityEvent`s carrying
 * the same extra keys, which is why the readers above check rather than
 * assert.
 */
export function useCodeActivityContents(
  messages: readonly ClientMessage[],
  streamingId: string | null,
): Array<{ id: string; createdAt: string; node: React.ReactNode }> {
  return React.useMemo(
    () =>
      messages.flatMap((message) => {
        if (message.role !== "ASSISTANT") return [];
        const events = (message.activity ?? []) as readonly CodeActivityEvent[];
        if (!events.some(isCodeRow)) return [];
        return [
          {
            id: `code-activity-${message.id}`,
            createdAt: message.createdAt,
            node: <CodeActivity events={events} streaming={message.id === streamingId} />,
          },
        ];
      }),
    [messages, streamingId],
  );
}

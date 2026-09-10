"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";

import { FileDiff, parseUnifiedDiff } from "@/components/aicss/file-diff";
import { CodeIcons, StatusIcons } from "@/lib/app-icons";
import { cn } from "@/lib/utils";
import type { CodeActivityEvent } from "@/hooks/use-code-session";
import type { ClientActivityEvent, ClientMessage } from "@/types/chat";

/*
 * A CODING TRANSCRIPT'S ROWS, IN THE FLOW OF THE TRANSCRIPT.
 *
 * Everything Juno Code does — every command, every file write, every request
 * for permission — arrived as an activity row and was folded into chat's
 * "Thought process" strip, whose ledger keeps a tool row only if its title
 * starts with "Using ". Code titles are `$ npm test — ok`, `Read x`, `Edit y`.
 * Nothing on the web rendered a single line of terminal output.
 *
 * This is the renderer the strip was standing in for: a mono command card
 * with its output one press away and its exit status on the row, a file row
 * with churn and its diff one press away, and an approval row. It is mounted
 * through `MessageList`'s `researchContents` slot (see
 * `useCodeActivityContents`), the one hook the chat transcript offers for
 * placing a surface's own nodes beside a turn without the chat components
 * knowing what they are.
 *
 * INTEGRATOR NOTE — two things this cannot do from here, both one line each
 * in src/components/chat, which this surface does not own:
 *   1. message-item.tsx still mounts `ActivityTimeline` for these same rows,
 *      so a Code turn carries the collapsed strip AND these cards. Skip the
 *      strip when the conversation's kind is "code".
 *   2. `liveCopy` in activity-timeline.tsx answers "Thinking about your
 *      request" for a Code tool row; `codeLiveCopy` below gives the honest
 *      sentence ("Running npm test"). Call it first for Code rows.
 */

/** What a tool row reports about how its process ended. */
export type ToolOutcome = "ok" | "failed" | "unknown";

/** The runner's own suffix on a bash summary, kept for producers that predate `exitCode`. */
const OUTCOME_SUFFIX = / — (ok|failed)$/;

/** The `Auto-allowed in sandbox: …` row the cloud driver writes instead of a fake approval pair. */
const AUTO_ALLOWED = /^Auto-allowed in sandbox: /;

/**
 * The exit status of a tool row, read from the number first and the title's
 * suffix second. The number is what the runner now sends; the suffix is what
 * every row persisted before it exists as.
 */
export function toolOutcome(event: ClientActivityEvent): ToolOutcome {
  const exit = (event as { exitCode?: unknown }).exitCode;
  if (typeof exit === "number") return exit === 0 ? "ok" : "failed";
  const suffix = OUTCOME_SUFFIX.exec(event.title)?.[1];
  if (suffix === "ok") return "ok";
  if (suffix === "failed") return "failed";
  if (/^Denied /.test(event.title)) return "failed";
  return "unknown";
}

/** The title without the runner's ` — ok` / ` — failed` suffix. */
export function toolLabel(event: ClientActivityEvent): string {
  return event.title.replace(OUTCOME_SUFFIX, "");
}

/** The exit code as a number, when the row carries one. */
function exitCodeOf(event: ClientActivityEvent): number | null {
  const exit = (event as { exitCode?: unknown }).exitCode;
  return typeof exit === "number" && Number.isFinite(exit) ? exit : null;
}

/** The diff a write row carries, when one was transported. Checked, not
 *  asserted: the chat vocabulary does not declare the key. */
function patchOf(event: ClientActivityEvent): string | null {
  const value = (event as { patch?: unknown }).patch;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * What the run is doing right now, as a sentence about the run.
 *
 * The chat strip's `liveCopy` answers "Thinking about your request" for every
 * Code row, because it recognises tool rows by a prefix Code never writes.
 * This is the Code answer: a command is running, a file is being read or
 * written, an approval is waited on. Null when the row is not one of those,
 * so the caller falls through to whatever it said before.
 */
export function codeLiveCopy(latest: ClientActivityEvent | undefined): string | null {
  if (!latest) return null;
  if (latest.kind === "tool") {
    const title = toolLabel(latest);
    if (AUTO_ALLOWED.test(title)) return title;
    if (title.startsWith("$ ")) return `Running ${title.slice(2)}`;
    if (title.startsWith("Read ")) return `Reading ${title.slice(5)}`;
    if (title.startsWith("Edit ")) return `Editing ${title.slice(5)}`;
    if (title.startsWith("Write ")) return `Writing ${title.slice(6)}`;
    if (title.startsWith("Glob ") || title.startsWith("Grep ")) return `Searching ${title.slice(5)}`;
    return title;
  }
  if (latest.kind === "write") {
    const space = latest.title.indexOf(" ");
    return `Writing ${space === -1 ? latest.title : latest.title.slice(space + 1)}`;
  }
  if (latest.kind === "warning") return latest.title;
  return null;
}

/** Whether a row is one this renderer draws. Chat-only kinds are skipped. */
function isCodeRow(event: ClientActivityEvent): boolean {
  return event.kind === "tool" || event.kind === "write" || event.kind === "warning" || event.kind === "done";
}

/* ── Rows ────────────────────────────────────────────────────────────────── */

const ROW = "flex min-w-0 items-start gap-2 rounded-control px-2 py-1.5 text-caption";

/**
 * One command: `$ npm test`, its exit status, and its output one press away.
 *
 * A failed command opens by default — its output is the thing the reader
 * wants — and everything else stays shut, because a run that read forty
 * files must not be forty open panes. `tabIndex` on the output so a keyboard
 * can reach the end of a scrolling region.
 */
function ToolRow({ event, live }: { event: ClientActivityEvent; live: boolean }) {
  const label = toolLabel(event);
  const outcome = toolOutcome(event);
  const exit = exitCodeOf(event);
  const detail = event.detail?.trim() ?? "";
  const hasOutput = detail.length > 0;
  const [open, setOpen] = React.useState(outcome === "failed");
  const outputId = React.useId();

  if (AUTO_ALLOWED.test(label)) {
    return (
      <li className={cn(ROW, "text-muted-foreground")}>
        <CodeIcons.permission className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">{label}</span>
      </li>
    );
  }

  const isCommand = label.startsWith("$ ");
  const glyph =
    outcome === "ok" ? (
      <StatusIcons.success className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden="true" />
    ) : outcome === "failed" ? (
      <StatusIcons.error className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden="true" />
    ) : live ? (
      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary motion-safe:animate-pulse" aria-hidden="true" />
    ) : (
      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground" aria-hidden="true" />
    );

  const body = (
    <>
      {glyph}
      <span className={cn("min-w-0 flex-1 break-words font-mono", isCommand ? "text-foreground" : "text-muted-foreground")}>
        {label}
      </span>
      {outcome === "failed" && exit !== null && exit !== 0 && (
        <span className="shrink-0 font-mono tabular-nums text-destructive">exit {exit}</span>
      )}
      <span className="sr-only">{outcome === "ok" ? ", succeeded" : outcome === "failed" ? ", failed" : ""}</span>
      {hasOutput && (
        <ChevronRight
          className={cn(
            "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform duration-fast ease-out-soft motion-reduce:transition-none",
            open && "rotate-90",
          )}
          aria-hidden="true"
        />
      )}
    </>
  );

  return (
    <li className="min-w-0">
      {hasOutput ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? outputId : undefined}
          onClick={() => setOpen((v) => !v)}
          className={cn(ROW, "w-full text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring")}
        >
          {body}
        </button>
      ) : (
        <div className={ROW}>{body}</div>
      )}
      {hasOutput && open && (
        <pre
          id={outputId}
          tabIndex={0}
          className="mx-2 mb-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xs border border-border/60 bg-muted/60 px-2.5 py-2 font-mono text-caption leading-5 text-muted-foreground"
        >
          {detail}
        </pre>
      )}
    </li>
  );
}

/** How a change kind reads: only the two non-default kinds get colour. */
function changeTone(kind: string): string {
  const k = kind.toLowerCase();
  if (k.startsWith("add") || k.startsWith("creat") || k === "new") return "text-success";
  if (k.startsWith("del") || k.startsWith("remov")) return "text-destructive";
  return "text-muted-foreground";
}

/**
 * One file the run wrote: kind, path, churn — and its diff, where one was
 * transported. A row with no patch is not expandable and shows no chevron:
 * null means "no diff arrived", never "the change was empty".
 */
function WriteRow({ event }: { event: ClientActivityEvent }) {
  const space = event.title.indexOf(" ");
  const kind = space === -1 ? "edit" : event.title.slice(0, space);
  const path = space === -1 ? event.title : event.title.slice(space + 1);
  const patch = patchOf(event);
  const [open, setOpen] = React.useState(false);
  const diffId = React.useId();
  // Parsed once per open, not per render: a 40 KB diff walked line by line
  // on every streamed token is the surface that streams hardest paying most.
  const rows = React.useMemo(() => (open && patch ? parseUnifiedDiff(patch) : null), [open, patch]);

  const body = (
    <>
      {patch ? (
        <ChevronRight
          className={cn(
            "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform duration-fast ease-out-soft motion-reduce:transition-none",
            open && "rotate-90",
          )}
          aria-hidden="true"
        />
      ) : (
        <CodeIcons.file className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <span className={cn("shrink-0 font-mono", changeTone(kind))}>{kind}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-foreground" title={path}>
        {path}
      </span>
      {event.detail && (
        <span className="shrink-0 font-mono tabular-nums text-muted-foreground">{event.detail}</span>
      )}
    </>
  );

  return (
    <li className="min-w-0">
      {patch ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? diffId : undefined}
          onClick={() => setOpen((v) => !v)}
          className={cn(ROW, "w-full text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring")}
        >
          {body}
        </button>
      ) : (
        <div className={ROW}>{body}</div>
      )}
      {rows && (
        <div id={diffId} tabIndex={0} className="mx-2 mb-1.5 max-h-72 overflow-auto">
          <FileDiff file={path} rows={rows} />
        </div>
      )}
    </li>
  );
}

/** An approval, a denial, a rollback outcome, a stop: the rows that are about
 *  the run rather than about a file or a command. */
function NoteRow({ event }: { event: ClientActivityEvent }) {
  const approval = event.title === "Approval requested";
  const Icon = approval ? CodeIcons.permission : event.kind === "done" ? StatusIcons.success : StatusIcons.warning;
  return (
    <li className={cn(ROW, event.kind === "done" ? "text-muted-foreground" : "text-warning-foreground")}>
      <Icon
        className={cn("mt-0.5 size-3.5 shrink-0", event.kind === "done" ? "text-success" : "text-warning")}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        {approval ? "Asked for approval" : event.title}
        {event.detail && (
          <>
            <span aria-hidden="true">: </span>
            <span className="font-mono text-foreground">{event.detail}</span>
          </>
        )}
      </span>
    </li>
  );
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
    <ul
      role="list"
      aria-label="What Juno Code did"
      // The same recipe as the run stack above the composer: one flat card,
      // rounded-field with p-0.5 so the rounded-control rows sit concentric.
      className={cn("surface-raised mt-2 rounded-field p-0.5", className)}
    >
      {rows.map((event) =>
        event.kind === "tool" ? (
          <ToolRow key={event.id} event={event} live={streaming && event === last} />
        ) : event.kind === "write" ? (
          <WriteRow key={event.id} event={event} />
        ) : (
          <NoteRow key={event.id} event={event} />
        ),
      )}
    </ul>
  );
}

/**
 * The transcript's Code rows, shaped for `MessageList`'s `researchContents`.
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

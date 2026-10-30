"use client";

/**
 * The agent's shell, as it happens, for the person to watch
 * (docs/design/agents-v2/COMPUTERS_2026-10.md S5.1).
 *
 * Read-only by construction: no input, no textarea, nothing editable, and no
 * key handler that sends anything anywhere. The only request it makes is a
 * GET of what the Work runner already stored, so nothing typed here can reach
 * the computer. Commands come from the agent, each one approved by the person
 * on its own card; this pane only shows what they printed.
 *
 * Polls once a second while a command is running, every few seconds while
 * the task is live, and stops once it has ended. Follows the newest output
 * unless the person scrolled up to read, and then offers "Jump to latest".
 */

import * as React from "react";
import { ArrowDown } from "@/components/ui/icons";
import { fetchShellOutput, type ClientShellOutputRow } from "@/components/agents/agents-transport";
import { cn } from "@/lib/utils";

/** How often the pane asks while a command is running. */
export const TERMINAL_POLL_RUNNING_MS = 1_000;
/** How often while the task is live but no command is running. */
export const TERMINAL_POLL_IDLE_MS = 3_000;
/** After a failed read. */
const TERMINAL_POLL_RETRY_MS = 5_000;
/** The most rows the pane holds; older ones fall off the top. */
const TERMINAL_MAX_ROWS = 4_000;
/** The runner's own words when a call's stored output reached its cap (shell-output.ts). */
export const TERMINAL_CAPPED_TEXT = "[output continues; the rest is in the result]";

/*
 * Escape sequences a terminal would interpret: CSI (colours, cursor moves),
 * OSC (titles, links), and the two-character ones; then every control
 * character but tab, newline and carriage return (handled below).
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** The text without ANSI escapes or control characters; a carriage return keeps what was drawn last on its line. */
export function stripAnsi(text: string): string {
  const clean = text.replace(ANSI, "");
  if (!clean.includes("\r")) return clean;
  return clean
    .split("\n")
    .map((line) => {
      const parts = line.split("\r");
      // "50%\r100%\r" redraws: the last non-empty piece is what is on screen.
      for (let i = parts.length - 1; i >= 0; i -= 1) if (parts[i]) return parts[i];
      return "";
    })
    .join("\n");
}

export interface TerminalSegment {
  stream: "stdout" | "stderr" | "note";
  text: string;
}

export interface TerminalBlock {
  callId: string;
  /** The command as the agent ran it, or null when its row was not read (older than the pane). */
  command: string | null;
  segments: TerminalSegment[];
  exit: { exitCode: number; timedOut: boolean } | null;
}

/** The rows, grouped by call in the order they were written, each call's output cleaned for display. */
export function terminalBlocks(rows: readonly ClientShellOutputRow[]): TerminalBlock[] {
  const blocks: TerminalBlock[] = [];
  const byCall = new Map<string, TerminalBlock>();
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
    let block = byCall.get(row.callId);
    if (!block) {
      block = { callId: row.callId, command: null, segments: [], exit: null };
      byCall.set(row.callId, block);
      blocks.push(block);
    }
    if (row.stream === "command") {
      block.command = row.text;
    } else if (row.stream === "exit") {
      let parsed: { exitCode?: unknown; timedOut?: unknown } = {};
      try {
        parsed = JSON.parse(row.text) as typeof parsed;
      } catch {
        parsed = {};
      }
      block.exit = {
        exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : -1,
        timedOut: parsed.timedOut === true,
      };
    } else if (row.stream === "stdout" && row.text.trim() === TERMINAL_CAPPED_TEXT) {
      block.segments.push({ stream: "note", text: TERMINAL_CAPPED_TEXT });
    } else {
      const last = block.segments[block.segments.length - 1];
      if (last && last.stream === row.stream) last.text += row.text;
      else block.segments.push({ stream: row.stream, text: row.text });
    }
  }
  for (const block of blocks) {
    block.segments = block.segments
      .map((segment) => (segment.stream === "note" ? segment : { ...segment, text: stripAnsi(segment.text) }))
      .filter((segment) => segment.text.length > 0);
  }
  return blocks;
}

/** Whether a command is still running: the newest call has no exit row yet. */
export function terminalRunning(rows: readonly ClientShellOutputRow[]): boolean {
  let newest: ClientShellOutputRow | null = null;
  for (const row of rows) if (!newest || row.seq > newest.seq) newest = row;
  if (!newest) return false;
  const callId = newest.callId;
  return !rows.some((row) => row.callId === callId && row.stream === "exit");
}

/** The next poll's delay, or null to stop: fast while a command runs, slower while the task is live, never after it ends. */
export function terminalPollDelay(state: { running: boolean; runLive: boolean; more: boolean }): number | null {
  if (state.more) return 0;
  if (!state.runLive) return null;
  return state.running ? TERMINAL_POLL_RUNNING_MS : TERMINAL_POLL_IDLE_MS;
}

/** Whether a scrolled box is at (or within a few pixels of) its bottom: the pane follows only then. */
export function isScrolledToBottom(box: { scrollTop: number; scrollHeight: number; clientHeight: number }, slack = 24): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= slack;
}

/** The line under a finished command. */
export function exitSentence(exit: { exitCode: number; timedOut: boolean }): { text: string; failed: boolean } {
  if (exit.timedOut) return { text: "Stopped: it ran past its time limit", failed: true };
  if (exit.exitCode === -1) return { text: "Did not finish", failed: true };
  return exit.exitCode === 0 ? { text: "exit 0", failed: false } : { text: `exit ${exit.exitCode}`, failed: true };
}

export function ComputerTerminal({
  agentId,
  agentName,
  runId,
  className,
}: {
  agentId: string;
  agentName: string;
  /** The task run whose shell output to show; null when the agent has no task. */
  runId: string | null;
  className?: string;
}) {
  const [rows, setRows] = React.useState<ClientShellOutputRow[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [following, setFollowing] = React.useState(true);
  const [unseen, setUnseen] = React.useState(false);
  const rowsRef = React.useRef<ClientShellOutputRow[]>([]);
  const scroller = React.useRef<HTMLDivElement>(null);
  const followingRef = React.useRef(true);

  React.useEffect(() => {
    rowsRef.current = [];
    setRows([]);
    setLoaded(false);
    setProblem(null);
    setUnseen(false);
    followingRef.current = true;
    setFollowing(true);
    if (!runId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cursor = 0;
    const tick = async () => {
      const outcome = await fetchShellOutput(agentId, runId, cursor);
      if (cancelled) return;
      let delay: number | null;
      if (outcome.kind === "ok") {
        const page = outcome.value;
        const fresh = page.rows.filter((row) => row.seq > cursor);
        cursor = Math.max(cursor, page.next);
        if (fresh.length > 0) {
          const next = [...rowsRef.current, ...fresh];
          rowsRef.current = next.length > TERMINAL_MAX_ROWS ? next.slice(next.length - TERMINAL_MAX_ROWS) : next;
          setRows(rowsRef.current);
          if (!followingRef.current) setUnseen(true);
        }
        setLoaded(true);
        setProblem(null);
        delay = terminalPollDelay({ running: terminalRunning(rowsRef.current), runLive: page.runLive, more: page.more });
      } else {
        setProblem(outcome.message);
        // Gone, or no longer the person's to read: stop asking.
        const status = outcome.kind === "failed" ? outcome.status : 0;
        delay = status === 401 || status === 403 || status === 404 ? null : TERMINAL_POLL_RETRY_MS;
      }
      if (delay !== null) timer = setTimeout(() => void tick(), delay);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [agentId, runId]);

  // Follows the newest output unless the person scrolled up to read.
  React.useLayoutEffect(() => {
    const box = scroller.current;
    if (box && followingRef.current) box.scrollTop = box.scrollHeight;
  }, [rows]);

  // A pane that was hidden while output arrived (the narrow screen's other
  // tab) has nothing to scroll; when it is shown, or resized, it catches up
  // with the bottom, still only while it is following.
  React.useEffect(() => {
    const box = scroller.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followingRef.current) box.scrollTop = box.scrollHeight;
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  const onScroll = () => {
    const box = scroller.current;
    if (!box) return;
    const atBottom = isScrolledToBottom(box);
    followingRef.current = atBottom;
    setFollowing(atBottom);
    if (atBottom) setUnseen(false);
  };

  const jumpToLatest = () => {
    const box = scroller.current;
    if (!box) return;
    followingRef.current = true;
    setFollowing(true);
    setUnseen(false);
    box.scrollTop = box.scrollHeight;
  };

  const blocks = terminalBlocks(rows);
  const running = terminalRunning(rows);

  return (
    <section
      aria-label={`${agentName}’s terminal`}
      className={cn("relative flex min-h-0 flex-col overflow-hidden rounded-panel bg-card ring-1 ring-border/60", className)}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-3 py-2">
        <p className="text-caption font-medium text-foreground">Terminal</p>
        <p className="text-micro text-muted-foreground">{running ? "Running · read-only" : "Read-only"}</p>
      </div>
      <div
        ref={scroller}
        role="log"
        aria-live="off"
        aria-label={`Commands ${agentName} ran and what they printed`}
        // Focusable so a keyboard can scroll it; it has no key handler of its own.
        tabIndex={0}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto overscroll-contain px-3 py-2 font-mono text-caption leading-relaxed text-foreground focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_hsl(var(--ring)/0.6)]"
        translate="no"
      >
        {!runId ? (
          <p className="font-sans text-ui text-muted-foreground">{agentName} hasn’t run a command yet. When it does, what it prints shows here as it happens.</p>
        ) : !loaded && !problem ? (
          <p className="font-sans text-ui text-muted-foreground">Loading…</p>
        ) : blocks.length === 0 && problem ? (
          <p className="font-sans text-ui text-foreground">{problem}</p>
        ) : blocks.length === 0 ? (
          <p className="font-sans text-ui text-muted-foreground">No commands in this task yet. When {agentName} runs one, what it prints shows here as it happens.</p>
        ) : (
          blocks.map((block) => {
            const exit = block.exit ? exitSentence(block.exit) : null;
            return (
              <div key={block.callId} className="mb-3 last:mb-0">
                <p className="whitespace-pre-wrap break-words font-medium text-foreground">
                  <span className="select-none text-muted-foreground" aria-hidden="true">
                    ${" "}
                  </span>
                  {block.command ?? "…"}
                </p>
                {block.segments.length > 0 ? (
                  <pre className="whitespace-pre-wrap break-words font-mono">
                    {block.segments.map((segment, index) => (
                      <span
                        key={index}
                        className={cn(
                          segment.stream === "stderr" && "text-muted-foreground",
                          segment.stream === "note" && "block font-sans italic text-muted-foreground"
                        )}
                      >
                        {segment.text}
                      </span>
                    ))}
                  </pre>
                ) : null}
                {exit ? (
                  <p className={cn("text-micro", exit.failed ? "text-destructive-ink" : "text-muted-foreground")}>{exit.text}</p>
                ) : null}
              </div>
            );
          })
        )}
      </div>
      {problem && blocks.length > 0 ? (
        <p role="status" className="shrink-0 border-t border-border/60 px-3 py-1.5 text-micro text-muted-foreground">
          {problem}
        </p>
      ) : null}
      {!following && unseen ? (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full bg-background/95 px-3 py-1 text-caption font-medium text-foreground shadow-soft ring-1 ring-border/60 hover:bg-accent coarse:min-h-11"
        >
          <ArrowDown className="size-3.5" aria-hidden="true" />
          Jump to latest
        </button>
      ) : null}
    </section>
  );
}

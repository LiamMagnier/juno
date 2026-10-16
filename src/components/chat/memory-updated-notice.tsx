"use client";

import * as React from "react";
import Link from "next/link";
import { X } from "@/components/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MemoryFactRow, forgetMemoryFact, useAllForgotten } from "@/components/chat/memory-fact-row";
import { memoryEntryHref } from "@/lib/chat/memory-receipts";
import { cn } from "@/lib/utils";
import type { ClientMemoryWrite } from "@/types/chat";

/*
 * "MEMORY UPDATED", AS SOMETHING YOU CAN ACT ON.
 *
 * It was two words that faded after four seconds, with two timers nobody
 * cleared: a second update inside the window was cut short by the first one's
 * timer, and leaving the chat left them running. A person who saw it could
 * not find out what had been saved, let alone take it back.
 *
 * Now it names the fact and offers what a person wants at that moment:
 *
 *   View   the fact on the memory page, lit;
 *   Edit   the sentence, here, without leaving the chat;
 *   Undo   take it back: the memory page's Forget, so it is not relearned,
 *          and whatever it replaced is believed again.
 *
 * It stays while the pointer or focus is on it, or while Edit is open, and
 * leaves on its own a few seconds after that. Each notice owns one timer, kept
 * in a ref and cleared on unmount; a new update is a new notice (the caller
 * keys it), so an older timer can never cut a newer notice short.
 *
 * Motion is the house pair for a floating status: rise in on arrival, the
 * title-out exit on the way out. The in-app Reduced setting and the system
 * setting both reach them (globals.css and `motion-safe`).
 */

/** How long the notice stays once nobody is looking at it. */
export const MEMORY_NOTICE_MS = 6000;
/** The exit's length: `--dur-exit`, read as a number for the unmount. */
const EXIT_MS = 180;

const actionClass =
  "inline-flex h-7 items-center rounded-control px-2 font-sans text-label text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground motion-reduce:transition-none coarse:h-9";

function truncate(text: string, max = 56): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function MemoryUpdatedNotice({ write, onDismiss }: { write: ClientMemoryWrite | null; onDismiss: () => void }) {
  const [leaving, setLeaving] = React.useState(false);
  const [held, setHeld] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);
  /** The exit's timer, once the notice has started to leave. */
  const exitTimer = React.useRef<number | null>(null);
  const dismissRef = React.useRef(onDismiss);
  React.useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  const saved = write?.saved ?? [];
  const forgotten = write?.forgotten ?? [];
  const first = saved[0];
  const allUndone = useAllForgotten(saved.map((fact) => fact.id));

  const leave = React.useCallback(() => {
    if (exitTimer.current !== null) return;
    setLeaving(true);
    exitTimer.current = window.setTimeout(() => dismissRef.current(), EXIT_MS);
  }, []);

  // The stay timer: started whenever nobody is holding the notice, and
  // cleared the moment somebody is (or it unmounts).
  React.useEffect(() => {
    if (held || editOpen || leaving) return;
    const stay = window.setTimeout(leave, MEMORY_NOTICE_MS);
    return () => window.clearTimeout(stay);
  }, [editOpen, held, leave, leaving]);
  React.useEffect(
    () => () => {
      if (exitTimer.current !== null) window.clearTimeout(exitTimer.current);
    },
    [],
  );

  const summary = first
    ? truncate(first.content)
    : forgotten[0]
      ? truncate(forgotten[0])
      : null;
  const more = saved.length > 1 ? saved.length - 1 : forgotten.length > 1 && !first ? forgotten.length - 1 : 0;

  return (
    <div
      role="status"
      aria-live="polite"
      data-memory-notice=""
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeld(false);
      }}
      className={cn(
        "pointer-events-auto inline-flex max-w-[min(40rem,calc(100vw-2rem))] items-center gap-1 rounded-full border border-border/70 bg-popover/95 py-1 pl-3 pr-1 shadow-glass backdrop-blur-sm",
        leaving
          ? "motion-safe:animate-title-out motion-safe:[animation-fill-mode:forwards]"
          : "motion-safe:animate-rise-in",
      )}
    >
      <span className="shrink-0 font-mono text-label text-muted-foreground">
        {allUndone ? "Memory change undone" : first ? "Memory updated" : "Forgotten"}
      </span>
      {summary && !allUndone && (
        <span className="hidden min-w-0 truncate text-label text-foreground/85 sm:inline">
          {" · "}
          {summary}
          {more > 0 ? <span className="text-muted-foreground"> +{more}</span> : null}
        </span>
      )}
      <span className="ml-1 flex shrink-0 items-center">
        <Link
          href={first ? memoryEntryHref(first.id) : "/memory"}
          className={actionClass}
          onClick={() => leave()}
        >
          View
        </Link>
        {first && !allUndone && (
          <Popover open={editOpen} onOpenChange={setEditOpen}>
            <PopoverTrigger asChild>
              <button type="button" className={cn(actionClass, "data-[state=open]:bg-accent data-[state=open]:text-foreground")}>
                {saved.length > 1 ? "Edit or undo" : "Edit"}
              </button>
            </PopoverTrigger>
            <PopoverContent align="center" side="bottom" sideOffset={8} className="w-[min(24rem,calc(100vw-2rem))] p-3">
              <p className="font-mono text-micro text-muted-foreground">Saved from this turn</p>
              <ul className="divide-y divide-border/60">
                {saved.map((fact) => (
                  <MemoryFactRow key={fact.id} fact={fact} saved onNavigate={() => setEditOpen(false)} />
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        )}
        {first && saved.length === 1 && !allUndone && <UndoButton id={first.id} />}
        <button type="button" aria-label="Dismiss" onClick={() => leave()} className={cn(actionClass, "px-1.5")}>
          <X aria-hidden="true" className="size-3.5" />
        </button>
      </span>
    </div>
  );
}

/**
 * Undo for the one fact a turn saved, without opening anything. Its name is
 * its word: the notice it sits in has just named the fact, and a sentence
 * built around the fact would never reach the translation catalog.
 */
function UndoButton({ id }: { id: string }) {
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        setFailed(false);
        const failure = await forgetMemoryFact(id, { undo: true });
        setBusy(false);
        setFailed(failure !== null);
      }}
      className={cn(actionClass, failed && "text-destructive hover:text-destructive")}
    >
      {busy ? "Undoing…" : failed ? "Try again" : "Undo"}
    </button>
  );
}

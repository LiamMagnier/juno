"use client";

import * as React from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { Check, X } from "@/components/ui/icons";
import { ComposerIcons } from "@/lib/app-icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MemoryFactRow, forgetMemoryFact, useAllForgotten } from "@/components/chat/memory-fact-row";
import { memoryEntryHref } from "@/lib/chat/memory-receipts";
import { cn } from "@/lib/utils";
import { useReducedMotion } from "@/lib/motion-preference";
import { DURATION } from "@/lib/design/tokens.generated";
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
 * title-out exit on the way out. The mark swaps to a tick in place when the
 * change is undone, and a hairline along the bottom drains over the stay
 * time, so the reader can see it will leave and that pointing at it holds it. The in-app Reduced setting and the system
 * setting both reach them (globals.css and `motion-safe`).
 */

/** How long the notice stays once nobody is looking at it. */
export const MEMORY_NOTICE_MS = 6000;
/** The exit's length: `--dur-exit` (`animate-title-out`), read from the token table for the unmount. It was a hand-typed 180. */
const EXIT_MS = DURATION.exit;

const actionClass =
  "inline-flex h-7 items-center gap-1 rounded-control px-2 font-sans text-caption font-medium text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground coarse:h-9";

/**
 * The fact, short enough for two lines of the notice, cut only between words.
 * It used to be one line clipped by CSS and a cut at the 71st character, so a
 * phone showed "Halvorsen is the …" with the fact's subject cut off mid-name.
 * Only a single word longer than half the limit (a pasted address) is cut
 * inside itself, because there is nowhere else to cut it.
 */
export function noticeSummary(text: string, max = 72): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const head = clean.slice(0, max);
  const lastSpace = head.lastIndexOf(" ");
  const cut = lastSpace > max / 2 ? head.slice(0, lastSpace) : head.slice(0, max - 1);
  return `${cut.replace(/[\s,;:.\u2013\u2014-]+$/, "")}…`;
}

export function MemoryUpdatedNotice({ write, onDismiss }: { write: ClientMemoryWrite | null; onDismiss: () => void }) {
  const [leaving, setLeaving] = React.useState(false);
  const [held, setHeld] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);
  /** The exit's timer, once the notice has started to leave. */
  const exitTimer = React.useRef<number | null>(null);
  const dismissRef = React.useRef(onDismiss);
  /** Where focus goes once Undo has taken its own button (and Edit) away. */
  const closeRef = React.useRef<HTMLButtonElement>(null);
  /** Restarts the countdown hairline each time the stay timer restarts. */
  const [lap, setLap] = React.useState(0);
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
    setLap((n) => n + 1);
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
    ? noticeSummary(first.content)
    : forgotten[0]
      ? noticeSummary(forgotten[0])
      : null;
  const more = saved.length > 1 ? saved.length - 1 : forgotten.length > 1 && !first ? forgotten.length - 1 : 0;
  const forgetOnly = !first && forgotten.length > 0;
  const counting = !held && !editOpen && !leaving;
  const reduce = useReducedMotion();

  return (
    <div
      role="status"
      aria-live="polite"
      data-memory-notice=""
      data-state={allUndone ? "undone" : forgetOnly ? "forgotten" : "saved"}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeld(false);
      }}
      className={cn(
        "pointer-events-auto relative isolate flex w-max max-w-[min(40rem,calc(100vw-2rem))] items-center gap-3 overflow-hidden rounded-panel border border-border/70 bg-popover py-2 pl-2 pr-1.5 shadow-glass",
        leaving
          ? "motion-safe:animate-title-out motion-safe:[animation-fill-mode:forwards]"
          : "motion-safe:animate-rise-in",
      )}
    >
      {/* The mark: memory's own glyph on a tile, a tick once the change is
          taken back. It swaps in place rather than the notice re-arriving. */}
      <span
        aria-hidden="true"
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-card transition-colors duration-base ease-out-soft",
          allUndone ? "bg-secondary text-muted-foreground" : "bg-primary/10 text-primary-ink",
        )}
      >
        {allUndone ? (
          <Check key="undone" className="size-4 motion-safe:animate-check-morph" />
        ) : forgetOnly ? (
          <ComposerIcons.memory key="forgot" className="size-4 motion-safe:animate-fade-in" />
        ) : (
          <ComposerIcons.memory key="saved" className="size-4 motion-safe:animate-fade-in" />
        )}
      </span>

      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex items-center gap-1.5 text-caption text-muted-foreground">
          {/* "Forgotten" only when the turn named what it forgot; a write it
              could not name (no receipt on the row) is still an update. */}
          <span className="truncate">{allUndone ? "Memory change undone" : forgetOnly ? "Forgotten" : "Memory updated"}</span>
          {more > 0 && !allUndone ? (
            <span className="shrink-0 rounded-full bg-secondary px-1.5 font-mono text-micro tabular-nums">+{more}</span>
          ) : null}
        </span>
        {summary && !allUndone ? (
          // Wraps to a second line rather than clipping: `noticeSummary`
          // already cut it between words, short enough for two.
          <span
            data-no-auto-translate
            className={cn(
              "min-w-0 whitespace-normal break-words text-ui font-medium leading-5 text-foreground",
              forgetOnly && "text-muted-foreground line-through decoration-muted-foreground/40",
            )}
          >
            {summary}
          </span>
        ) : null}
      </span>

      <span className="flex shrink-0 items-center">
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
            <PopoverContent align="end" side="bottom" sideOffset={8} className="w-[min(24rem,calc(100vw-2rem))] p-3">
              <p className="text-caption font-medium text-muted-foreground">Saved from this turn</p>
              <ul className="divide-y divide-border/60">
                {saved.map((fact) => (
                  <MemoryFactRow key={fact.id} fact={fact} saved onNavigate={() => setEditOpen(false)} />
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        )}
        {first && saved.length === 1 && !allUndone && (
          <UndoButton id={first.id} onUndone={() => requestAnimationFrame(() => closeRef.current?.focus())} />
        )}
        <span aria-hidden="true" className="mx-1 h-4 w-px bg-border/80" />
        <button ref={closeRef} type="button" aria-label="Dismiss" onClick={() => leave()} className={cn(actionClass, "px-1.5")}>
          <X aria-hidden="true" className="size-3.5" />
        </button>
      </span>

      {/* How long it stays, drawn: a hairline that drains while nobody holds
          the notice and refills when somebody does. Motion only; under
          reduced motion it is not drawn (the notice still leaves on time). */}
      {counting && !reduce ? (
        <motion.span
          key={lap}
          aria-hidden="true"
          data-notice-countdown=""
          className="pointer-events-none absolute inset-x-0 bottom-0 h-px origin-left bg-foreground/15"
          initial={{ scaleX: 1 }}
          animate={{ scaleX: 0 }}
          // A countdown runs at the clock's own pace: linear, the stay's length.
          transition={{ duration: MEMORY_NOTICE_MS / 1000, ease: "linear" }}
        />
      ) : null}
    </div>
  );
}

/**
 * Undo for the one fact a turn saved, without opening anything. Its name is
 * its word: the notice it sits in has just named the fact, and a sentence
 * built around the fact would never reach the translation catalog.
 */
function UndoButton({ id, onUndone }: { id: string; onUndone: () => void }) {
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
        // The button goes with the change it undid; a keyboard reader's focus
        // moves on to Dismiss rather than falling to the page.
        if (failure === null) onUndone();
      }}
      className={cn(actionClass, "text-foreground", failed && "text-destructive hover:text-destructive")}
    >
      {busy ? "Undoing…" : failed ? "Try again" : "Undo"}
    </button>
  );
}

/**
 * On a phone, "Memory updated" is not drawn over the conversation: the answer
 * that saved the fact already says it in its own chip (AnswerMemory, "Memory
 * updated" under the answer) with the same View, Edit and Undo, so a notice
 * at the top only covered the transcript the reader was looking at. What a
 * screen reader would have heard from the notice is still said, here, once:
 * the region is in place before its words arrive, so it is announced, and it
 * goes with the notice's own timing. Used only for a write the turn could
 * name; one it could not has no chip, so the notice is drawn (above the
 * composer, chat-view.tsx).
 */
export function MemoryUpdatedAnnouncement({ write, onDismiss }: { write: ClientMemoryWrite; onDismiss: () => void }) {
  const [text, setText] = React.useState("");
  const dismissRef = React.useRef(onDismiss);
  React.useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);
  const first = write.saved[0];
  const forgotten = write.forgotten?.[0];
  const sentence = first ? `Memory updated: ${noticeSummary(first.content)}` : forgotten ? `Forgotten: ${noticeSummary(forgotten)}` : "Memory updated";
  React.useEffect(() => {
    const frame = requestAnimationFrame(() => setText(sentence));
    const stay = window.setTimeout(() => dismissRef.current(), MEMORY_NOTICE_MS);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(stay);
    };
  }, [sentence]);
  return (
    <p role="status" aria-live="polite" className="sr-only" data-memory-announcement="">
      {text}
    </p>
  );
}

"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Undo2 } from "@/components/ui/icons";
import { StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ComposerPrimaryAction, useComposerAutosize } from "@/components/ui/composer-shell";
import { ThinkingDots } from "@/components/signature/thinking-dots";
import { transition } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { OperationDiff } from "@/components/memory/operation-diff";
import type { MemoryEditRecord } from "@/components/memory/memory-model";
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * The one way to change memory in words, and the place its answer lands.
 *
 * The instruction used to be typed into a pill that floated over the summary
 * from a pencil button, and the diff it produced was filed in a collapsed
 * "Manage edits" card further down the page, so an instruction that worked
 * looked, from the reader's seat, like a toast and nothing else. Now the bar
 * is always there, under the summary it edits, and the drafted change unfolds
 * directly beneath it: ask, read the diff, apply, all without the eye leaving
 * the spot. An applied change keeps an Undo in the same place for a few
 * seconds before it folds away; the full history is in the activity sheet.
 *
 * Drafting writes nothing (see useMemory's `instruct`), so the diff is a
 * question, not a notification: Discard costs nothing, and Apply is the only
 * write.
 */

/** How long an applied change keeps its inline Undo before folding away. */
const APPLIED_HOLD_MS = 4500;

// Named so the copy extractor reads them: a string inside a ternary prop is invisible to it.
const PROMPT_PLACEHOLDER = `Tell ${PRODUCT_NAME} what to remember, change or forget`;
const PAUSED_PLACEHOLDER = "Memory is off. Turn it on to make changes.";
/** Three shapes of instruction, one press each to start from: add, correct, forget. */
const SUGGESTIONS = ["I moved to a new city", "I prefer answers in French", "Forget where I used to work"];

export interface PromptDockHandle {
  focus: () => void;
}

interface PromptDockProps {
  /** The whole ledger; the dock shows what is waiting and what just landed. */
  edits: MemoryEditRecord[];
  busyEditIds: ReadonlySet<string>;
  /** Memory is off: the bar says so instead of taking an instruction. */
  paused: boolean;
  onInstruct: (instruction: string) => Promise<boolean>;
  onAccept: (edit: MemoryEditRecord) => Promise<void>;
  onUndo: (edit: MemoryEditRecord) => Promise<void>;
  onDiscard: (id: string) => Promise<void>;
  /**
   * Edits applied from the dock, and when; each shows "Applied" with its Undo
   * until the hold runs out. Held by the caller because the dock moves: an
   * instruction applied from the empty-state welcome lands on the full page,
   * in the summary panel's dock, and its Undo has to be there too.
   */
  justApplied: ReadonlyMap<string, number>;
  onJustAppliedChange: React.Dispatch<React.SetStateAction<ReadonlyMap<string, number>>>;
  className?: string;
}

export const PromptDock = React.forwardRef<PromptDockHandle, PromptDockProps>(function PromptDock(
  { edits, busyEditIds, paused, onInstruct, onAccept, onUndo, onDiscard, justApplied, onJustAppliedChange, className },
  ref
) {
  const [value, setValue] = React.useState("");
  const [drafting, setDrafting] = React.useState<string | null>(null);
  const setJustApplied = onJustAppliedChange;
  const fieldRef = React.useRef<HTMLTextAreaElement>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion() ?? false;

  useComposerAutosize(fieldRef, value, { maxLines: 5 });

  React.useImperativeHandle(ref, () => ({ focus: () => fieldRef.current?.focus() }), []);

  // Each applied change folds away on its own clock.
  React.useEffect(() => {
    if (justApplied.size === 0) return;
    const now = Date.now();
    const next = Math.min(...[...justApplied.values()].map((at) => at + APPLIED_HOLD_MS - now));
    const timer = window.setTimeout(() => {
      setJustApplied((prev) => {
        const kept = new Map([...prev].filter(([, at]) => at + APPLIED_HOLD_MS > Date.now()));
        return kept.size === prev.size ? prev : kept;
      });
    }, Math.max(0, next));
    return () => window.clearTimeout(timer);
  }, [justApplied, setJustApplied]);

  const submit = async () => {
    const instruction = value.trim();
    if (!instruction || drafting || paused) return;
    setDrafting(instruction);
    setValue("");
    const done = await onInstruct(instruction);
    setDrafting(null);
    if (!done) {
      // Nothing was drafted: hand the sentence back so it can be fixed.
      setValue(instruction);
      requestAnimationFrame(() => fieldRef.current?.focus());
    }
  };

  const pending = edits.filter((edit) => edit.status === "pending");
  const applied = edits.filter((edit) => edit.status === "applied" && justApplied.has(edit.id));

  /*
   * Apply, Discard and Undo each fold away the row their button sits in (and
   * the button disables itself while it works), and a focused button that
   * leaves the page drops a keyboard reader at the top of the document. The
   * bar above is the dock's one fixed control, so focus returns there. Only
   * after a keyboard press, read at the press since the button has lost focus
   * by the time the work is done: after a tap, focusing a text field would
   * raise a phone's keyboard unasked.
   */
  const pressedFromKeyboard = () => {
    const active = document.activeElement;
    return active instanceof HTMLElement && !!rootRef.current?.contains(active) && active.matches(":focus-visible");
  };
  const returnFocus = (fromKeyboard: boolean) => {
    if (!fromKeyboard || paused) return;
    const active = document.activeElement;
    // Unless the reader has already moved on somewhere else.
    if (!active || active === document.body || rootRef.current?.contains(active)) fieldRef.current?.focus();
  };

  const accept = async (edit: MemoryEditRecord) => {
    const fromKeyboard = pressedFromKeyboard();
    await onAccept(edit);
    setJustApplied((prev) => new Map(prev).set(edit.id, Date.now()));
    returnFocus(fromKeyboard);
  };

  const discard = async (edit: MemoryEditRecord) => {
    const fromKeyboard = pressedFromKeyboard();
    await onDiscard(edit.id);
    returnFocus(fromKeyboard);
  };

  // The applied line needs no clearing here: a successful Undo turns the edit
  // back to pending, which takes the line away, and a failed one leaves it
  // applied with its Undo still in reach until the hold runs out.
  const undo = async (edit: MemoryEditRecord) => {
    const fromKeyboard = pressedFromKeyboard();
    await onUndo(edit);
    returnFocus(fromKeyboard);
  };

  // Everything under the bar unfolds out of it and folds back into it: the
  // row track opens (the sanctioned disclosure) while the content rises 6px.
  const unfold = {
    initial: reduceMotion ? { opacity: 0 } : { opacity: 0, gridTemplateRows: "0fr" },
    animate: { opacity: 1, gridTemplateRows: "1fr", transition: { gridTemplateRows: transition.symmetric, opacity: transition.base } },
    exit: reduceMotion
      ? { opacity: 0, transition: transition.exit }
      : { opacity: 0, gridTemplateRows: "0fr", transition: { gridTemplateRows: transition.symmetric, opacity: transition.exit } },
  };
  const rise = reduceMotion
    ? {}
    : { initial: { y: 6 }, animate: { y: 0, transition: transition.base } };

  const busy = drafting !== null;

  return (
    <div ref={rootRef} className={className}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className={cn(
          // The composer's shape (22px, no shadow, the edge raises on focus):
          // telling memory something is a message to Alevr, so it looks like
          // one. 10px inset keeps the 12px send button concentric (22 − 10).
          "flex items-end gap-2 rounded-composer border border-input bg-background py-2.5 pl-5 pr-2.5 transition-colors duration-fast ease-out-soft motion-reduce:transition-none",
          !paused && "hover:border-foreground/40 focus-within:border-foreground/60"
        )}
      >
        <div className="relative min-w-0 flex-1 self-center">
          <textarea
            ref={fieldRef}
            value={value}
            rows={1}
            maxLength={600}
            // Read-only while a draft is written, not disabled: a disabled
            // field loses focus, and the reader typing the next instruction
            // would find it gone.
            disabled={paused}
            readOnly={busy}
            aria-busy={busy}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit();
              } else if (event.key === "Escape" && value) {
                event.preventDefault();
                setValue("");
              }
            }}
            placeholder={busy ? "" : paused ? PAUSED_PLACEHOLDER : PROMPT_PLACEHOLDER}
            aria-label={PROMPT_PLACEHOLDER}
            className="block w-full resize-none bg-transparent py-1.5 text-body text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />
          {busy && (
            <span
              role="status"
              className="pointer-events-none absolute inset-0 flex items-center gap-2 text-ui text-muted-foreground motion-safe:animate-fade-in"
            >
              <ThinkingDots />
              <span>Drafting the change…</span>
            </span>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <ComposerPrimaryAction
              type="submit"
              face={busy ? "busy" : "send"}
              disabled={paused || busy || !value.trim()}
              aria-label="Draft this change"
            />
          </TooltipTrigger>
          <TooltipContent>Draft this change</TooltipContent>
        </Tooltip>
      </form>

      {/* Starting points while the bar is empty and nothing is waiting: the
          three things the bar can do, each one press from a draft. */}
      <AnimatePresence initial={false}>
        {!paused && !busy && !value && drafting === null && pending.length === 0 && (
          <motion.div key="suggestions" className="grid" {...unfold}>
            <div className="min-h-0 overflow-hidden">
              <div className="flex flex-wrap items-center gap-1.5 px-1 pt-3">
                {SUGGESTIONS.map((text) => (
                  <button
                    key={text}
                    type="button"
                    onClick={() => {
                      setValue(text);
                      requestAnimationFrame(() => {
                        const field = fieldRef.current;
                        if (!field) return;
                        field.focus();
                        field.setSelectionRange(text.length, text.length);
                      });
                    }}
                    className="inline-flex h-7 items-center rounded-full border border-border/70 px-3 text-caption text-muted-foreground transition-[color,background-color,transform] duration-fast ease-out-soft hover:bg-muted hover:text-foreground active:scale-[0.97] motion-reduce:transition-none"
                  >
                    {text}
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {drafting !== null && (
          <motion.div key="drafting" className="grid" {...unfold}>
            <div className="min-h-0 overflow-hidden">
              <motion.p {...rise} className="px-3.5 pt-2.5 text-caption text-muted-foreground">
                <span>Drafting from</span> <q className="text-foreground">{drafting}</q>
              </motion.p>
            </div>
          </motion.div>
        )}

        {pending.map((edit) => (
          <motion.div key={`${edit.id}:pending`} className="grid" {...unfold}>
            <div className="min-h-0 overflow-hidden">
              <motion.div {...rise} className="pt-2">
                <ProposalCard
                  edit={edit}
                  busy={busyEditIds.has(edit.id)}
                  onAccept={() => void accept(edit)}
                  onDiscard={() => void discard(edit)}
                />
              </motion.div>
            </div>
          </motion.div>
        ))}

        {applied.map((edit) => (
          <motion.div key={`${edit.id}:applied`} className="grid" {...unfold}>
            <div className="min-h-0 overflow-hidden">
              <div className="pt-2">
                <div
                  role="status"
                  className="flex items-center gap-2.5 rounded-field bg-success/10 py-1.5 pl-3 pr-1.5 text-ui"
                >
                  <StatusIcons.success className="size-4 shrink-0 text-success" aria-hidden="true" />
                  <span className="shrink-0 font-medium">Applied</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{edit.summary ?? edit.instruction}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={busyEditIds.has(edit.id)}
                    onClick={() => void undo(edit)}
                    className="shrink-0 gap-1.5"
                  >
                    <Undo2 className="size-3.5" aria-hidden="true" />
                    Undo
                  </Button>
                </div>
              </div>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
});

/**
 * A drafted change, waiting for a decision. The reader's own words first (the
 * thing they are checking the diff against), then what Juno made of them, then
 * the lines themselves, edge to edge so the tint reads as a band.
 */
function ProposalCard({
  edit,
  busy,
  onAccept,
  onDiscard,
}: {
  edit: MemoryEditRecord;
  busy: boolean;
  onAccept: () => void;
  onDiscard: () => void;
}) {
  return (
    <div role="group" aria-label="Proposed change" className="overflow-hidden rounded-field border border-border bg-background">
      <div className="px-3.5 pb-2.5 pt-3">
        <p className="text-caption text-muted-foreground">
          <q>{edit.instruction}</q>
        </p>
        {edit.summary && <p className="mt-1 text-ui font-medium text-foreground">{edit.summary}</p>}
      </div>
      <OperationDiff operations={edit.operations} className="rounded-none border-y border-border" />
      <div className="flex items-center justify-end gap-1.5 px-2 py-2">
        <Button variant="ghost" size="sm" onClick={onDiscard} disabled={busy}>
          Discard
        </Button>
        <Button size="sm" onClick={onAccept} loading={busy}>
          Apply change
        </Button>
      </div>
    </div>
  );
}

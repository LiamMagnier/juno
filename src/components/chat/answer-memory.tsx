"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown } from "@/components/ui/icons";
import { ComposerIcons } from "@/lib/app-icons";
import { MemoryFactRow } from "@/components/chat/memory-fact-row";
import { answerMemory, answerMemoryLabel } from "@/lib/chat/memory-receipts";
import { cn } from "@/lib/utils";
import type { ClientActivityEvent } from "@/types/chat";

/*
 * THE ANSWER'S MEMORY RECEIPT — which saved memories this answer was given,
 * and what the turn saved or forgot.
 *
 * It used to live only in the thought-process panel's details, one disclosure
 * deep, so "why does it think I live in Lisbon?" had an answer nobody found.
 * It now sits under the answer beside the bibliography, drawn the same way:
 * the same raised chip, the same in-place unfold (grid rows 0fr→1fr, clipped
 * only while it moves), because it answers the same kind of question — what
 * this answer rests on. Each fact can be edited, forgotten (or, for one the
 * turn just saved, undone), marked not relevant to this answer, and opened on
 * the memory page; each says where it was learned, with a link to that chat.
 *
 * Shown only when memory actually had a part in the turn: an empty receipt
 * under every answer would teach people not to read it.
 */
export function AnswerMemory({
  activity,
  conversationId = null,
  className,
}: {
  activity: readonly ClientActivityEvent[] | undefined;
  /** The chat this answer is in: a fact learned here says so instead of linking to itself. */
  conversationId?: string | null;
  className?: string;
}) {
  const memory = React.useMemo(() => answerMemory(activity), [activity]);
  const [open, setOpen] = React.useState(false);
  const listId = React.useId();
  // Clip only while the fold moves, so focus outlines on the first and last
  // rows are not cut once it has opened (the SourcesPill note explains why).
  const [settled, setSettled] = React.useState(false);
  React.useEffect(() => {
    if (!open) {
      setSettled(false);
      return;
    }
    const timer = window.setTimeout(() => setSettled(true), 240);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (memory.used.length === 0 && memory.saved.length === 0 && memory.forgotten.length === 0) return null;
  const { kind, count, updated } = answerMemoryLabel(memory);

  return (
    <div className={cn("mt-2", className)} data-answer-memory="">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={listId}
        data-state={open ? "on" : "off"}
        className="group/pill control-neu relative z-0 inline-flex h-9 items-center gap-2 rounded-full pl-2.5 pr-3 hover:z-10 coarse:h-11"
      >
        <ComposerIcons.memory aria-hidden="true" className="size-3.5 text-muted-foreground" />
        {/* Each phrase is its own text node, so the catalog translates it
            whole; the count rides beside it, as it does on "Sources". */}
        <span className="text-caption font-medium text-muted-foreground transition-colors duration-fast ease-out-soft group-hover/pill:text-foreground motion-reduce:transition-none">
          {kind === "used" ? "Memory" : kind === "saved" ? "Memory updated" : "Forgotten"}
        </span>
        {count !== null && (
          <span className="font-mono text-caption tabular-nums text-muted-foreground">
            {count}
            <span className="sr-only"> </span>
            <span className="sr-only">{count === 1 ? "memory used in this answer" : "memories used in this answer"}</span>
          </span>
        )}
        {updated && (
          <span className="inline-flex items-center gap-1 text-caption text-primary-ink">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
            <span>updated</span>
          </span>
        )}
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-3.5 text-ink-tertiary transition-transform duration-base ease-in-out motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>

      <div
        id={listId}
        className={cn(
          "grid transition-[grid-template-rows] duration-base ease-out-soft motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className={cn("min-h-0", settled ? "overflow-visible" : "overflow-hidden")} inert={!open}>
          <div className="mt-2 max-w-xl rounded-xl border border-border/60 bg-card/60 px-3.5 pb-1.5 pt-3">
            {memory.used.length > 0 && (
              <section aria-label="Used in this answer">
                <h4 className="text-caption font-medium text-muted-foreground">Used in this answer</h4>
                <ul className="divide-y divide-border/60">
                  {memory.used.map((fact) => (
                    <MemoryFactRow key={fact.id} fact={fact} conversationId={conversationId} />
                  ))}
                </ul>
              </section>
            )}
            {memory.saved.length > 0 && (
              <section aria-label="Saved from this turn" className={cn(memory.used.length > 0 && "mt-2 border-t border-border/60 pt-3")}>
                <h4 className="text-caption font-medium text-muted-foreground">Saved from this turn</h4>
                <ul className="divide-y divide-border/60">
                  {memory.saved.map((fact) => (
                    <MemoryFactRow key={fact.id} fact={fact} saved />
                  ))}
                </ul>
              </section>
            )}
            {memory.forgotten.length > 0 && (
              <section
                aria-label="Forgotten at your request"
                className={cn((memory.used.length > 0 || memory.saved.length > 0) && "mt-2 border-t border-border/60 pt-3")}
              >
                <h4 className="text-caption font-medium text-muted-foreground">Forgotten at your request</h4>
                <ul className="divide-y divide-border/60">
                  {memory.forgotten.map((statement) => (
                    <li key={statement} className="py-2 text-ui text-muted-foreground line-through decoration-muted-foreground/40">
                      {statement}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <Link
              href="/memory"
              className="mt-1 inline-flex min-h-8 items-center rounded-xs text-caption text-muted-foreground underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-foreground hover:underline motion-reduce:transition-none"
            >
              Manage memory
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { transition } from "@/lib/motion";
import { useReducedMotion } from "@/lib/motion-preference";
import { MemoryRowMeta } from "@/components/memory/entry-row";
import type { Memory } from "@/components/memory/memory-model";
import { overlapKey, type MemoryOverlap } from "@/lib/memory-overlaps";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { cn } from "@/lib/utils";

/*
 * "NEEDS A LOOK": two memories that may say the same thing, or that disagree,
 * found by memory-overlaps.ts, set at the top of the list with the two side by
 * side and one decision each.
 *
 *   Keep this   the other one becomes history behind it (No longer used),
 *               with an Undo while the toast is up;
 *   Keep both   they are both right (two homes, two jobs); the page stops
 *               asking about that pair.
 *
 * Nothing is merged on the page's own initiative. The lifecycle already
 * merges what it can be sure of; what reaches this panel is what it could
 * get wrong, which is exactly what the person should decide.
 */

const NOTE = `Keep the one that’s right. The other moves to No longer used, and ${PRODUCT_NAME} stops using it.`;

export function OverlapsPanel({
  overlaps,
  memories,
  onKeep,
  onKeepBoth,
}: {
  overlaps: readonly MemoryOverlap[];
  /** The rows the pairs name, by id. */
  memories: ReadonlyMap<string, Memory>;
  onKeep: (keep: Memory, drop: Memory, overlap: MemoryOverlap) => void;
  onKeepBoth: (overlap: MemoryOverlap) => void;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  const shown = overlaps.filter((overlap) => overlap.ids.every((id) => memories.has(id)));
  // Folded to one line until asked for (owner, 18 Nov 2026): the pairs stood
  // above the list as a second titled box, before the memories themselves.
  const [open, setOpen] = React.useState(false);
  const pairs = shown.length === 1 ? "One pair" : `${shown.length} pairs`;
  const fold = {
    initial: reduceMotion ? { opacity: 0 } : { opacity: 0, gridTemplateRows: "0fr" },
    animate: { opacity: 1, gridTemplateRows: "1fr", transition: transition.symmetric },
    exit: reduceMotion ? { opacity: 0, transition: transition.exit } : { opacity: 0, gridTemplateRows: "0fr", transition: transition.exit },
  };

  return (
    <AnimatePresence initial={false}>
      {shown.length > 0 && (
        <motion.section key="overlaps" aria-labelledby="memory-overlaps-heading" className="grid" data-memory-overlaps="" {...fold}>
          <div className="min-h-0 overflow-hidden">
            <div className={cn("mem-surface rounded-panel px-4 py-2", open && "pb-3")}>
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <h3 id="memory-overlaps-heading" className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-foreground">
                  <span className="text-ui font-medium">Needs a look</span>
                  <span className="text-ui text-muted-foreground">{`${pairs} may repeat or contradict each other.`}</span>
                </h3>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={open}
                  aria-controls="memory-overlaps-pairs"
                  onClick={() => setOpen((value) => !value)}
                  className="-mr-2 px-2.5 text-muted-foreground hover:text-foreground"
                >
                  {open ? "Done" : "Review"}
                </Button>
              </div>
              <div id="memory-overlaps-pairs" hidden={!open}>
              <p className="mt-1 max-w-prose text-ui text-muted-foreground">{NOTE}</p>
              <AnimatePresence initial={false}>
                {shown.map((overlap) => {
                  const [a, b] = overlap.ids.map((id) => memories.get(id)!);
                  return (
                    <motion.div key={overlapKey(overlap.ids)} className="grid" {...fold}>
                      <div className="min-h-0 overflow-hidden">
                        <div className="mt-4 border-t border-[var(--mem-hair)] pt-3" data-memory-overlap={overlap.kind}>
                          <p className="text-ui font-medium text-foreground">
                            {overlap.kind === "duplicate" ? (
                              <span>These may say the same thing</span>
                            ) : overlap.noun ? (
                              <>
                                <span>These disagree about</span> <span>{overlap.noun}</span>
                              </>
                            ) : (
                              <span>These disagree</span>
                            )}
                          </p>
                          <ul className="mt-1">
                            {[
                              [a, b],
                              [b, a],
                            ].map(([keep, drop]) => (
                              <li key={keep.id} className="flex items-start gap-3 py-2">
                                <div className="min-w-0 flex-1">
                                  <p className="text-pretty text-body text-foreground">{keep.content}</p>
                                  <MemoryRowMeta memory={keep} showProject={false} />
                                </div>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => onKeep(keep, drop, overlap)}
                                  className="shrink-0"
                                >
                                  Keep this
                                </Button>
                              </li>
                            ))}
                          </ul>
                          <div className="-ml-2.5 pb-1">
                            <Button variant="ghost" size="sm" onClick={() => onKeepBoth(overlap)} className="px-2.5 text-muted-foreground">
                              Keep both
                            </Button>
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
              </div>
            </div>
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}

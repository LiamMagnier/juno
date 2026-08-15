"use client";

import * as React from "react";
import { Pressable } from "@/components/ui/pressable";
import {
  TRIAGE_LABEL,
  WORK_TRIAGE_STATES,
  type WorkTriageState,
} from "@/components/work/inbox/triage";
import { cn } from "@/lib/utils";

/*
 * The pill row, and the reason the counts are on it.
 *
 * A filter bar with bare labels makes the reader press each one to find out
 * whether it is worth pressing. With the count on the pill the whole shape of
 * the account is legible from one line — three need you, one is running,
 * nothing is scheduled — which is the entire argument for an inbox over a
 * grouped list: you can see what you have without operating anything.
 *
 * A ZERO IS SHOWN, NOT HIDDEN. "Needs you 0" is the single most useful thing
 * this bar ever says, and a product that hides it makes the reader prove a
 * negative by pressing a pill. Only `all` is exempt: its count is the total,
 * which the list underneath is already showing.
 *
 * It is a `role="tablist"`, not a group of buttons. These select which of
 * several views of the same list is shown, which is what tabs are, and the
 * role is what gives a keyboard user the arrow-key traversal they expect
 * instead of tabbing through six controls to reach the seventh thing.
 */

export interface TriageCounts {
  needs_you: number;
  in_progress: number;
  scheduled: number;
  unread: number;
  done: number;
  all: number;
}

export function TriageBar({
  value,
  counts,
  onChange,
  className,
}: {
  value: WorkTriageState;
  counts: TriageCounts;
  onChange: (next: WorkTriageState) => void;
  className?: string;
}) {
  const refs = React.useRef(new Map<WorkTriageState, HTMLButtonElement | null>());

  /*
   * Arrow-key traversal, which `role="tablist"` promises and nothing provides
   * for free. Home and End are included because a six-item bar is long enough
   * that "get me back to the first one" is a real request, and because a reader
   * who has learned the pattern on one tablist expects it on the next.
   */
  const onKeyDown = (event: React.KeyboardEvent) => {
    const index = WORK_TRIAGE_STATES.indexOf(value);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % WORK_TRIAGE_STATES.length;
    if (event.key === "ArrowLeft") next = (index - 1 + WORK_TRIAGE_STATES.length) % WORK_TRIAGE_STATES.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = WORK_TRIAGE_STATES.length - 1;
    if (next === null) return;
    event.preventDefault();
    const state = WORK_TRIAGE_STATES[next];
    onChange(state);
    // Focus follows selection, which is the automatic-activation tablist
    // pattern. Correct here because switching views is instant and free — there
    // is no load behind a pill — so manual activation would only add a keypress.
    refs.current.get(state)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Filter your tasks"
      onKeyDown={onKeyDown}
      className={cn("flex flex-wrap items-center gap-1.5", className)}
    >
      {WORK_TRIAGE_STATES.map((state) => {
        const selected = state === value;
        const count = counts[state];
        return (
          <Pressable
            key={state}
            ref={(node) => {
              refs.current.set(state, node);
            }}
            kind="chip"
            size="lg"
            selected={selected}
            role="tab"
            aria-selected={selected}
            // Only the selected pill is in the tab order; the rest are reached
            // with the arrow keys. That is the tablist contract, and without it
            // this bar costs a keyboard user six presses to get past.
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(state)}
            className={cn(
              "gap-2",
              // `needs_you` carries a warm edge when it has anything in it, and
              // loses it at zero. The colour is never the only signal — the word
              // and the number are right there — but an inbox whose one urgent
              // filter looks exactly like "All" is an inbox that buries the
              // thing it exists to surface.
              state === "needs_you" && count > 0 && !selected && "border-warning/50 text-warning-foreground"
            )}
          >
            {TRIAGE_LABEL[state]}
            {state !== "all" && (
              <span
                className={cn(
                  "font-mono text-micro tabular-nums",
                  selected ? "text-primary-ink" : "text-muted-foreground"
                )}
              >
                {count}
              </span>
            )}
          </Pressable>
        );
      })}
    </div>
  );
}

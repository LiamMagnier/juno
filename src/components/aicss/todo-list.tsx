"use client";

import * as React from "react";
import { CheckCircle2, ChevronDown, CircleDashed, List, PlayCircle } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────────────────────────
 * AIcss "To-do List" — a plan that reports against itself.
 *
 * The header glyph IS the status: a list before anything starts, a determinate
 * pie while it works, a filled check when it is done — and it becomes a chevron
 * on hover, because on hover the only thing you can do with a header is fold it.
 * That is three states and an affordance in one 16px box, with no label spent on
 * any of them.
 *
 * As with the other blocks, AIcss's own version walks itself through five
 * hardcoded tasks on a timer. This one is given items and shows exactly what it
 * was given.
 * ───────────────────────────────────────────────────────────────────────────── */

export type TodoState = "pending" | "active" | "done";

export interface TodoItem {
  id: string;
  label: string;
  state: TodoState;
}

/*
 * The glyphs are the set's (icons.tsx); the classes are what globals.css sizes,
 * stacks and cross-fades. Each row holds all three status marks in one 16px box
 * and `data-on` picks which one is visible, so a task changing state is a
 * cross-fade in place rather than a glyph swapped under the text.
 *
 * The pie ring is not an icon — it is the determinate progress drawing, data,
 * and stays hand-drawn.
 */
const PendingIcon = ({ on }: { on: boolean }) => (
  <CircleDashed className="aicss-todo-icon" data-on={on} />
);
const ActiveIcon = ({ on }: { on: boolean }) => (
  <PlayCircle className="aicss-todo-icon aicss-todo-icon-strong" data-on={on} motion="none" />
);
const DoneIcon = ({ on }: { on: boolean }) => (
  <CheckCircle2 className="aicss-todo-icon" data-on={on} />
);

/** One character slot that rolls the old glyph out and the new one in. */
function RollDigit({ char }: { char: string }) {
  const previous = React.useRef(char);
  const [roll, setRoll] = React.useState<{ from: string; to: string } | null>(null);
  const [rolled, setRolled] = React.useState(false);

  React.useEffect(() => {
    if (char === previous.current) return;
    const from = previous.current;
    previous.current = char;
    setRoll({ from, to: char });
    setRolled(false);
    // Two frames: one to commit the un-rolled position, one to start from it.
    // A single rAF lands in the same paint as the mount and the transition is
    // skipped entirely.
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setRolled(true)));
    const done = window.setTimeout(() => setRoll(null), 380);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(done);
    };
  }, [char]);

  if (!roll) return <span className="aicss-todo-digit">{char}</span>;
  return (
    <span className="aicss-todo-digit">
      <span className="aicss-todo-digit-inner" data-rolled={rolled}>
        <span>{roll.from}</span>
        <span>{roll.to}</span>
      </span>
    </span>
  );
}

function RollingCount({ value }: { value: string }) {
  return (
    <span className="aicss-todo-roll" aria-hidden="true">
      {value.split("").map((char, i) => (
        <RollDigit key={i} char={char} />
      ))}
    </span>
  );
}

export function TodoList({
  items,
  title = "To-dos",
  defaultOpen = true,
  className,
}: {
  items: TodoItem[];
  title?: string;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const listId = React.useId();

  const total = items.length;
  const done = items.filter((item) => item.state === "done").length;
  const running = items.some((item) => item.state === "active");
  const allDone = total > 0 && done === total;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <div className={cn("aicss-todo", className)}>
      <button
        type="button"
        className="aicss-todo-head"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`${title} — ${done} of ${total} done`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="aicss-todo-head-icon">
          {/* The filled check is a STATE — the plan is finished — which is the
              one thing `weight="fill"` means in this set. */}
          {allDone ? (
            <CheckCircle2 className="aicss-todo-head-check" weight="fill" />
          ) : running ? (
            <span
              className="aicss-todo-pie"
              style={{ ["--aicss-todo-pie" as string]: `${pct}%` }}
              aria-hidden="true"
            >
              <svg className="aicss-todo-pie-ring" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeDasharray="2.2 4.4" strokeLinecap="round" />
              </svg>
            </span>
          ) : (
            <List className="aicss-todo-list-icon" />
          )}
          {/* The fold caret turns on the symmetric curve (both ends visible);
              `.aicss-todo-chevron` in globals.css carries it. */}
          <ChevronDown className="aicss-todo-chevron" />
        </span>
        <span className="aicss-todo-title">{title}</span>
        <span className="aicss-todo-count">
          <RollingCount value={`${done}/${total}`} />
        </span>
      </button>

      <div className="aicss-todo-collapsible" data-collapsed={open ? "false" : "true"}>
        <div className="aicss-todo-inner">
          <ul className="aicss-todo-items" id={listId} inert={!open}>
            {items.map((item, i) => (
              <li
                key={item.id}
                className="aicss-todo-item"
                data-state={item.state}
                style={{ ["--aicss-todo-i" as string]: i }}
              >
                <span className="aicss-todo-icon-wrap">
                  <PendingIcon on={item.state === "pending"} />
                  <ActiveIcon on={item.state === "active"} />
                  <DoneIcon on={item.state === "done"} />
                </span>
                {/* data-label feeds the ::before shine layer, so the muted and
                    active states share one box and the row cannot shift. */}
                <span className="aicss-todo-label" data-label={item.label}>
                  {item.label}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

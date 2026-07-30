"use client";

import * as React from "react";
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

const ICON_PROPS = {
  viewBox: "0 0 24 24",
  width: 16,
  height: 16,
  "aria-hidden": true,
} as const;

const DashedIcon = ({ on }: { on: boolean }) => (
  <svg {...ICON_PROPS} className="aicss-todo-icon" data-on={on}>
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeDasharray="1.8 3.6" strokeLinecap="round" />
  </svg>
);
const ArrowIcon = ({ on }: { on: boolean }) => (
  <svg {...ICON_PROPS} className="aicss-todo-icon aicss-todo-icon-strong" data-on={on}>
    <path d="m12.75 15 3-3m0 0-3-3m3 3h-7.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const CheckIcon = ({ on }: { on: boolean }) => (
  <svg {...ICON_PROPS} className="aicss-todo-icon" data-on={on}>
    <path d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const FilledCheckIcon = () => (
  <svg {...ICON_PROPS} className="aicss-todo-head-check">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm13.36-1.814a.75.75 0 1 0-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.14-.094l3.75-5.25Z"
      fill="currentColor"
    />
  </svg>
);
const ListIcon = () => (
  <svg {...ICON_PROPS} className="aicss-todo-list-icon">
    <path
      d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0ZM3.75 12h.007v.008H3.75V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm-.375 5.25h.007v.008H3.75v-.008Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
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
          {allDone ? (
            <FilledCheckIcon />
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
            <ListIcon />
          )}
          <svg {...ICON_PROPS} className="aicss-todo-chevron">
            <path d="m19.5 8.25-7.5 7.5-7.5-7.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
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
                  <DashedIcon on={item.state === "pending"} />
                  <ArrowIcon on={item.state === "active"} />
                  <CheckIcon on={item.state === "done"} />
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

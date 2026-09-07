"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A year of activity, one square per day.
 *
 * The contribution-graph shape, because it answers the question a person
 * brings to a usage page — "when do I actually use this, and how much" — in
 * one glance, without a legend to decode: darker is more, and the eye finds
 * the busy weeks and the quiet months on its own.
 *
 * Three decisions worth recording:
 *
 *  - Levels are QUANTILES of the active days, not fractions of the maximum.
 *    One enormous day used to flatten the other three hundred into the
 *    palest shade, and the graph read as "nothing happened" for a year of
 *    daily use. Quartiles mean a quarter of the active days sit in each shade
 *    whatever the outlier did.
 *  - Days are keyed in UTC, because that is how the ledger keys them
 *    (`/api/profile/stats` slices `toISOString()`). Walking local days and
 *    reading UTC keys is how the whole grid once shifted a square left.
 *  - Every square is a real button. A hover tooltip is a mouse affordance;
 *    the keyboard and screen-reader path goes through the button's name,
 *    and picking a day pins its detail under the grid for everybody.
 */

export interface ActivityDay {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  tokens: number;
  count: number;
}

export interface ActivityCell extends ActivityDay {
  level: 0 | 1 | 2 | 3 | 4;
  /** Column index, oldest week first. */
  week: number;
  /** Row index, Sunday = 0. */
  weekday: number;
  future: boolean;
}

const DAY_MS = 86_400_000;
const WEEKS = 53;
const WEEKDAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LEVEL_CLASS = [
  "bg-muted",
  "bg-primary/25",
  "bg-primary/45",
  "bg-primary/70",
  "bg-primary",
] as const;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function utcMidnight(date = new Date()): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Quartile thresholds over the active days' token counts. */
function levelFor(sorted: number[]): (tokens: number) => ActivityCell["level"] {
  if (sorted.length === 0) return () => 0;
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
  const q1 = at(0.25);
  const q2 = at(0.5);
  const q3 = at(0.75);
  return (tokens) => {
    if (tokens <= 0) return 0;
    if (tokens <= q1) return 1;
    if (tokens <= q2) return 2;
    if (tokens <= q3) return 3;
    return 4;
  };
}

/**
 * The 53-week grid ending today, Sunday on top like every graph of this shape.
 * Days after today in the final column are `future` and drawn empty.
 */
export function buildActivityGrid(daily: Record<string, { tokens: number; count: number } | undefined>, now = new Date()): {
  cells: ActivityCell[];
  weeks: number;
  months: Array<{ label: string; week: number }>;
} {
  const today = utcMidnight(now);
  const todayWeekday = new Date(today).getUTCDay();
  const start = today - todayWeekday * DAY_MS - (WEEKS - 1) * 7 * DAY_MS;
  const active = Object.values(daily)
    .map((day) => day?.tokens ?? 0)
    .filter((tokens) => tokens > 0)
    .sort((a, b) => a - b);
  const level = levelFor(active);
  const cells: ActivityCell[] = [];
  const months: Array<{ label: string; week: number }> = [];
  let lastMonth = -1;
  for (let week = 0; week < WEEKS; week += 1) {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const ms = start + (week * 7 + weekday) * DAY_MS;
      const date = isoDay(ms);
      const day = daily[date];
      const future = ms > today;
      const tokens = future ? 0 : (day?.tokens ?? 0);
      cells.push({ date, tokens, count: future ? 0 : (day?.count ?? 0), level: future ? 0 : level(tokens), week, weekday, future });
      // A month label sits over the first column that holds the 1st of it, so
      // the labels drift with the calendar instead of sitting at fixed spacing.
      const month = new Date(ms).getUTCMonth();
      if (month !== lastMonth && !future) {
        if (weekday === 0 || week === 0) {
          if (months.length === 0 || months[months.length - 1]!.week < week - 1 || week === 0) {
            months.push({ label: MONTHS[month]!, week });
          }
        } else if (new Date(ms).getUTCDate() === 1) {
          months.push({ label: MONTHS[month]!, week: week + 1 });
        }
        lastMonth = month;
      }
    }
  }
  // Two labels that landed in adjacent columns overprint; keep the later one.
  const spaced = months.filter((month, i) => i === months.length - 1 || months[i + 1]!.week - month.week >= 3);
  return { cells, weeks: WEEKS, months: spaced.filter((month) => month.week < WEEKS) };
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return `${n}`;
}

function longDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function cellLabel(cell: ActivityCell): string {
  if (cell.future) return `${longDate(cell.date)} — not yet`;
  if (cell.count === 0) return `${longDate(cell.date)} — no activity`;
  return `${longDate(cell.date)} — ${cell.count} ${cell.count === 1 ? "reply" : "replies"}, ${formatTokens(cell.tokens)} tokens`;
}

export function ActivityHeatmap({
  daily,
  className,
  onSelect,
}: {
  daily: Record<string, { tokens: number; count: number } | undefined>;
  className?: string;
  /** Fires when a day is picked or the selection is cleared. */
  onSelect?: (day: ActivityCell | null) => void;
}) {
  const { cells, weeks, months } = React.useMemo(() => buildActivityGrid(daily), [daily]);
  const [hover, setHover] = React.useState<{ cell: ActivityCell; x: number; y: number } | null>(null);
  const [selected, setSelected] = React.useState<ActivityCell | null>(null);
  const scroller = React.useRef<HTMLDivElement>(null);
  const grid = React.useRef<HTMLDivElement>(null);
  const tooltipId = React.useId();

  // The newest week is on the right; a narrow pane opens on it, not on last year.
  React.useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [cells]);

  const peak = React.useMemo(
    () => cells.reduce<ActivityCell | null>((best, cell) => (cell.tokens > (best?.tokens ?? 0) ? cell : best), null),
    [cells]
  );

  const pick = (cell: ActivityCell | null) => {
    setSelected(cell);
    onSelect?.(cell);
  };

  const place = (target: HTMLElement, cell: ActivityCell) => {
    const host = grid.current;
    if (!host) return;
    const a = target.getBoundingClientRect();
    const b = host.getBoundingClientRect();
    setHover({ cell, x: a.left - b.left + a.width / 2, y: a.top - b.top });
  };

  return (
    <div className={cn("activity-heatmap", className)}>
      <div ref={scroller} className="no-scrollbar -mx-1 overflow-x-auto px-1 pb-1">
        <div className="relative inline-block min-w-full">
          {/* Month labels ride the same column track as the grid. */}
          <div
            aria-hidden
            className="ml-8 grid text-caption text-muted-foreground"
            style={{ gridTemplateColumns: `repeat(${weeks}, var(--cell))`, columnGap: "var(--gap)", height: 16 }}
          >
            {months.map((month) => (
              <span
                key={`${month.label}-${month.week}`}
                className="whitespace-nowrap leading-4"
                style={{ gridColumn: `${month.week + 1} / span 3` }}
              >
                {month.label}
              </span>
            ))}
          </div>
          <div className="flex">
            <div
              aria-hidden
              className="grid w-8 shrink-0 pr-1 text-right font-mono text-micro text-muted-foreground"
              style={{ gridTemplateRows: "repeat(7, var(--cell))", rowGap: "var(--gap)" }}
            >
              {WEEKDAY_LABELS.map((label, i) => (
                <span key={i} className="flex items-center justify-end leading-none">
                  {label}
                </span>
              ))}
            </div>
            <div
              ref={grid}
              role="group"
              aria-label="Daily activity over the last year"
              className="relative grid"
              style={{
                gridTemplateRows: "repeat(7, var(--cell))",
                gridAutoFlow: "column",
                gridAutoColumns: "var(--cell)",
                gap: "var(--gap)",
              }}
              onMouseLeave={() => setHover(null)}
            >
              {cells.map((cell) => {
                const isSelected = selected?.date === cell.date;
                const isPeak = peak?.date === cell.date && cell.tokens > 0;
                return (
                  <button
                    key={cell.date}
                    type="button"
                    tabIndex={cell.future ? -1 : 0}
                    disabled={cell.future}
                    aria-label={cellLabel(cell)}
                    aria-pressed={isSelected}
                    aria-describedby={hover?.cell.date === cell.date ? tooltipId : undefined}
                    data-level={cell.level}
                    onMouseEnter={(event) => place(event.currentTarget, cell)}
                    onFocus={(event) => place(event.currentTarget, cell)}
                    onBlur={() => setHover(null)}
                    onClick={() => pick(isSelected ? null : cell)}
                    className={cn(
                      "activity-cell block size-[var(--cell)] rounded-micro motion-safe:animate-fade-in",
                      "transition-[transform,box-shadow] duration-fast ease-out-soft motion-reduce:transition-none",
                      "hover:scale-125 focus-visible:scale-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                      cell.future ? "bg-muted/40" : LEVEL_CLASS[cell.level],
                      isSelected && "ring-2 ring-foreground/70 ring-offset-1 ring-offset-background",
                      isPeak && !isSelected && "ring-1 ring-primary/60 ring-offset-1 ring-offset-background"
                    )}
                    style={{ animationDelay: `${Math.min(cell.week, 52) * 8}ms`, animationFillMode: "both" }}
                  />
                );
              })}
              {hover && (
                <div
                  id={tooltipId}
                  role="tooltip"
                  className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+8px)] whitespace-nowrap rounded-control bg-foreground px-2.5 py-1.5 text-caption text-background shadow-float motion-safe:animate-pop-in"
                  style={{ left: hover.x, top: hover.y }}
                >
                  {hover.cell.future ? (
                    <span className="text-background/70">Not yet</span>
                  ) : hover.cell.count === 0 ? (
                    <span>
                      <span className="text-background/70">No activity on </span>
                      {longDate(hover.cell.date)}
                    </span>
                  ) : (
                    <span>
                      <span className="font-medium tabular-nums">
                        {hover.cell.count} {hover.cell.count === 1 ? "reply" : "replies"}
                      </span>
                      <span className="text-background/70"> · {formatTokens(hover.cell.tokens)} tokens · </span>
                      {longDate(hover.cell.date)}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pl-8">
        <p className="min-h-5 text-caption text-muted-foreground">
          {selected ? (
            <>
              <span className="text-foreground">{longDate(selected.date)}</span>
              {selected.count > 0 ? (
                <>
                  {" · "}
                  <span className="tabular-nums">{selected.count} {selected.count === 1 ? "reply" : "replies"}</span>
                  {" · "}
                  <span className="tabular-nums">{formatTokens(selected.tokens)} tokens</span>
                  {peak?.date === selected.date && <span className="ml-2 text-primary-ink">Your busiest day</span>}
                </>
              ) : (
                " · a quiet day"
              )}
              <button
                type="button"
                onClick={() => pick(null)}
                className="ml-2 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Clear
              </button>
            </>
          ) : peak && peak.tokens > 0 ? (
            <>
              Busiest day <span className="text-foreground">{longDate(peak.date)}</span>
              {" · "}
              <span className="tabular-nums">{formatTokens(peak.tokens)} tokens</span>
            </>
          ) : (
            "Pick a day to see what happened."
          )}
        </p>
        <div aria-hidden className="flex items-center gap-1 text-caption text-muted-foreground">
          <span className="mr-0.5">Less</span>
          {LEVEL_CLASS.map((level) => (
            <span key={level} className={cn("block size-[var(--cell)] rounded-micro", level)} />
          ))}
          <span className="ml-0.5">More</span>
        </div>
      </div>
    </div>
  );
}

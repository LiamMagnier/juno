"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import {
  addDays,
  buildWeeks,
  cumulativeSeries,
  daysBetween,
  formatDayLong,
  formatDayShort,
  formatTokens,
  formatTokensExact,
  gridStart,
  heatLevel,
  heatThresholds,
  monthLabels,
  weeklyTotals,
  type ActivityDay,
  type GridCell,
} from "@/lib/profile-activity";

export type ActivityView = "daily" | "weekly" | "cumulative";

const WEEKS = 53;
const WEEKDAYS = ["Mon", "", "Wed", "", "Fri", "", ""];

/**
 * A year of tokens, three ways, on one set of columns.
 *
 *  - Daily: the contribution grid, one square per day, Monday at the top.
 *  - Weekly: the same 53 columns, each a bar of that week's total, so a week
 *    is compared with a week by length rather than by squinting at shades.
 *  - Cumulative: the running total as a line across the same width. A grid
 *    shaded by a running total would only ever get darker to the right and
 *    say nothing a line does not say better: where the climb is steep is
 *    where the work was.
 *
 * All three share the month labels underneath and the weekday column, so a
 * switch changes the marks and nothing else moves.
 *
 * ONE TAB STOP. The chart is a single focusable group, not 371 buttons: the
 * arrow keys walk the days (Left/Right a week, Up/Down a day in the grid),
 * Home and End jump to the ends, and a polite live region reads out the day
 * the pointer or the keyboard is on, with its exact count.
 */
export function ActivityChart({
  days,
  today,
  view,
  animate,
}: {
  days: readonly ActivityDay[];
  today: string;
  view: ActivityView;
  /** Play the arrival once; later switches only cross-fade. */
  animate: boolean;
}) {
  const weeks = React.useMemo(() => buildWeeks(days, today, WEEKS), [days, today]);
  const start = gridStart(weeks) ?? today;
  const cells = React.useMemo(() => weeks.flat().filter((c): c is GridCell => c !== null), [weeks]);
  const thresholds = React.useMemo(() => heatThresholds(cells.map((c) => c.tokens)), [cells]);
  const labels = React.useMemo(() => monthLabels(weeks), [weeks]);
  const weekly = React.useMemo(() => weeklyTotals(weeks), [weeks]);
  const cumulative = React.useMemo(() => cumulativeSeries(days, start, today), [days, start, today]);

  // The active mark: a day key for daily and cumulative, a column for weekly.
  const [active, setActive] = React.useState<string | null>(null);
  const [focused, setFocused] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const trackRef = React.useRef<HTMLDivElement>(null);
  const tipRef = React.useRef<HTMLDivElement>(null);
  const fromKeyboard = React.useRef(false);

  React.useEffect(() => setActive(null), [view]);

  // The latest weeks are what a reader came for: open scrolled to the end.
  React.useLayoutEffect(() => {
    const track = trackRef.current;
    if (track) track.scrollLeft = track.scrollWidth;
  }, [view]);

  const tip = describe(view, active, { cells, weekly, cumulative });

  // Place the tooltip over the active mark, inside the wrapper (the track
  // clips vertically, so the tip cannot live in it), clamped to its edges.
  React.useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const tipEl = tipRef.current;
    if (!wrap || !tipEl || !tip) return;
    const mark = wrap.querySelector<HTMLElement>("[data-active]");
    if (!mark) return;
    if (fromKeyboard.current) {
      mark.scrollIntoView({ block: "nearest", inline: "nearest" });
      fromKeyboard.current = false;
    }
    const w = wrap.getBoundingClientRect();
    const m = mark.getBoundingClientRect();
    const tw = tipEl.offsetWidth;
    const th = tipEl.offsetHeight;
    const center = m.left - w.left + m.width / 2;
    const left = Math.min(Math.max(center - tw / 2, 0), w.width - tw);
    let top = m.top - w.top - th - 8;
    // Above the mark unless that would leave the window; then below it.
    if (m.top - th - 8 < 0) top = m.bottom - w.top + 8;
    tipEl.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  });

  const lastIndex = cumulative.length - 1;
  /** Where a key moves the active mark; undefined when the key is not ours. */
  const nextActive = (key: string, shift: boolean): string | undefined => {
    if (view === "weekly") {
      const i = active === null ? weekly.length - 1 : Number(active);
      const to = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: weekly.length - 1 }[key];
      return to === undefined ? undefined : String(Math.min(Math.max(to, 0), weekly.length - 1));
    }
    if (key === "Home") return start;
    if (key === "End") return today;
    const moves: Record<string, number> =
      view === "daily" ? { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 } : { ArrowLeft: shift ? -7 : -1, ArrowRight: shift ? 7 : 1 };
    if (!(key in moves)) return undefined;
    const to = addDays(active ?? today, moves[key]);
    return to < start ? start : to > today ? today : to;
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setActive(null);
      return;
    }
    const next = nextActive(e.key, e.shiftKey);
    if (next === undefined) return;
    e.preventDefault();
    fromKeyboard.current = true;
    setActive(next);
  };

  const label =
    view === "daily"
      ? "Tokens per day over the last year. Arrow keys move between days."
      : view === "weekly"
        ? "Tokens per week over the last year. Left and right arrows move between weeks."
        : "Running total of tokens over the last year. Left and right arrows move between days.";

  return (
    <div ref={wrapRef} className="pf-chart relative">
      <div className="flex">
        <div className="pf-weekdays shrink-0 text-muted-foreground" aria-hidden="true">
          {WEEKDAYS.map((d, i) => (
            <span key={i} className={cn("pf-mono", view !== "daily" && "invisible")}>
              {d}
            </span>
          ))}
        </div>
        <div ref={trackRef} className="pf-track min-w-0 flex-1">
          <div
            role="group"
            aria-roledescription="chart"
            aria-label={label}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onFocus={() => {
              setFocused(true);
              if (active === null) setActive(view === "weekly" ? String(weekly.length - 1) : today);
            }}
            onBlur={() => {
              setFocused(false);
              setActive(null);
            }}
            onPointerLeave={() => {
              if (!focused) setActive(null);
            }}
            className={cn("pf-focus w-max", animate && "pf-enter")}
          >
            <div key={view} className={cn(!animate && "pf-swap")}>
              {view === "daily" && (
                <div className="pf-cols pf-grid">
                  {weeks.map((col, c) =>
                    col.map((cell, r) =>
                      cell ? (
                        <span
                          key={cell.date}
                          className="pf-cell"
                          data-level={heatLevel(cell.tokens, thresholds)}
                          data-today={cell.date === today || undefined}
                          data-active={active === cell.date || undefined}
                          style={{ gridColumn: c + 1, gridRow: r + 1, ["--c" as string]: c, ["--r" as string]: r }}
                          onPointerEnter={() => setActive(cell.date)}
                        />
                      ) : null
                    )
                  )}
                </div>
              )}
              {view === "weekly" && <WeeklyBars weekly={weekly} active={active} onHover={setActive} />}
              {view === "cumulative" && (
                <CumulativeLine
                  points={cumulative}
                  active={active === null ? null : daysBetween(start, active)}
                  onHover={(i) => setActive(cumulative[Math.min(Math.max(i, 0), lastIndex)]?.date ?? null)}
                />
              )}
            </div>
            <div className="pf-cols mt-2 h-4" aria-hidden="true">
              {labels.map((l) => (
                <span
                  key={`${l.col}-${l.label}`}
                  className="pf-mono overflow-visible whitespace-nowrap text-caption text-muted-foreground"
                  // Near the right edge a label would widen the track past
                  // its last column; it ends on the last column instead.
                  style={
                    l.col > WEEKS - 3
                      ? { gridRow: 1, gridColumn: `${WEEKS - 2} / span 3`, justifySelf: "end" }
                      : { gridRow: 1, gridColumn: `${l.col + 1} / span 3` }
                  }
                >
                  {l.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {tip && (
        <div ref={tipRef} className="pf-tip surface-float left-0 top-0 rounded-control px-2.5 py-1.5" aria-hidden="true">
          <div className="text-ui text-foreground">
            <span className="pf-mono">{tip.value}</span> {tip.unit}
          </div>
          <div className="text-caption text-muted-foreground">{tip.detail}</div>
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {tip ? `${tip.detail}: ${tip.value} ${tip.unit}` : ""}
      </p>
    </div>
  );
}

function WeeklyBars({
  weekly,
  active,
  onHover,
}: {
  weekly: ReturnType<typeof weeklyTotals>;
  active: string | null;
  onHover: (key: string) => void;
}) {
  const max = Math.max(1, ...weekly.map((w) => w.tokens));
  return (
    <div className="pf-cols pf-bars">
      {weekly.map((w, i) => (
        <span
          key={w.start || i}
          className="pf-bar-slot"
          data-active={active === String(i) || undefined}
          onPointerEnter={() => onHover(String(i))}
          style={{ ["--c" as string]: i }}
        >
          <span className="pf-bar" data-zero={w.tokens === 0 || undefined} style={{ height: `${Math.max(2, (w.tokens / max) * 100)}%` }} />
        </span>
      ))}
    </div>
  );
}

/** The x of day `i` in a viewBox one unit per day, centred in its column's band. */
const DAY_UNITS = WEEKS * 7;

function CumulativeLine({
  points,
  active,
  onHover,
}: {
  points: ReturnType<typeof cumulativeSeries>;
  active: number | null;
  onHover: (index: number) => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const max = Math.max(1, points[points.length - 1]?.total ?? 0);
  const y = (total: number) => 100 - (total / max) * 90;
  const x = (i: number) => i + 0.5;
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)} ${y(p.total).toFixed(2)}`).join("");
  const last = points.length - 1;
  const area = points.length ? `${line}L${x(last).toFixed(2)} 100L${x(0).toFixed(2)} 100Z` : "";
  const pct = (i: number) => `${(x(i) / DAY_UNITS) * 100}%`;
  const onMove = (e: React.PointerEvent) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    onHover(Math.round(((e.clientX - r.left) / r.width) * DAY_UNITS - 0.5));
  };
  const a = active !== null && points[active] ? active : null;
  return (
    <div ref={ref} className="relative" style={{ height: "var(--pf-plot)", width: "calc(var(--pf-cell) * var(--pf-cols) + var(--pf-gap) * (var(--pf-cols) - 1))" }} onPointerMove={onMove}>
      <svg viewBox={`0 0 ${DAY_UNITS} 100`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden="true">
        <line x1={0} x2={DAY_UNITS} y1={100} y2={100} className="pf-base" />
        {area && <path d={area} className="pf-area" />}
        {line && <path d={line} pathLength={1} className="pf-line" />}
      </svg>
      {a !== null && (
        <>
          <span className="pf-cross" style={{ left: pct(a) }} />
          <span className="pf-dot" data-active style={{ left: pct(a), top: `${y(points[a].total)}%` }} />
        </>
      )}
    </div>
  );
}

function describe(
  view: ActivityView,
  active: string | null,
  data: { cells: GridCell[]; weekly: ReturnType<typeof weeklyTotals>; cumulative: ReturnType<typeof cumulativeSeries> }
): { value: string; unit: string; detail: string } | null {
  if (active === null) return null;
  if (view === "weekly") {
    const w = data.weekly[Number(active)];
    if (!w) return null;
    return {
      value: formatTokensExact(w.tokens),
      unit: w.tokens === 1 ? "token" : "tokens",
      detail: `${formatDayShort(w.start)} to ${formatDayShort(w.end)}`,
    };
  }
  if (view === "cumulative") {
    const p = data.cumulative.find((q) => q.date === active);
    if (!p) return null;
    return {
      value: formatTokensExact(p.total),
      unit: "tokens so far",
      detail: p.tokens > 0 ? `${formatDayLong(p.date)}, +${formatTokens(p.tokens)} that day` : formatDayLong(p.date),
    };
  }
  const c = data.cells.find((q) => q.date === active);
  if (!c) return null;
  return {
    value: c.tokens > 0 ? formatTokensExact(c.tokens) : "No",
    unit: c.tokens === 1 ? "token" : "tokens",
    detail: formatDayLong(c.date),
  };
}

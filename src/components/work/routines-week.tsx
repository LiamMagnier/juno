"use client";

import * as React from "react";
import type { ClientWorkSchedule } from "@/lib/work/schedule";

/**
 * The next seven days, drawn: one column per day, the hours running down,
 * and a point where each active routine next runs. The soonest is the one
 * live object, in presence blue with its name beside it. Real data only:
 * a routine with no next run (event triggers, paused) is not plotted.
 */

const W = 560;
const H = 260;
const TOP = 28;
const BOTTOM = 12;
const DAY_MS = 24 * 60 * 60 * 1000;

export function RoutinesWeek({ schedules, now = Date.now() }: { schedules: ClientWorkSchedule[]; now?: number }) {
  const start = React.useMemo(() => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }, [now]);
  const colW = W / 7;
  const points = React.useMemo(
    () =>
      schedules
        .filter((s) => s.enabled && s.nextRunAt)
        .map((s) => ({ s, at: new Date(s.nextRunAt as string).getTime() }))
        .filter(({ at }) => at >= now && at < start + 7 * DAY_MS)
        .sort((a, b) => a.at - b.at),
    [schedules, now, start]
  );
  const soonest = points[0] ?? null;
  const place = (at: number) => {
    const day = Math.floor((at - start) / DAY_MS);
    const frac = ((at - start) % DAY_MS) / DAY_MS;
    return { x: colW * day + colW / 2, y: TOP + frac * (H - TOP - BOTTOM) };
  };
  const nowY = TOP + (((now - start) % DAY_MS) / DAY_MS) * (H - TOP - BOTTOM);
  const dayName = (i: number) =>
    new Date(start + i * DAY_MS).toLocaleDateString(undefined, { weekday: "short" });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="When your routines run next, over the coming week" className="h-auto w-full overflow-visible">
      {Array.from({ length: 7 }, (_, i) => (
        <g key={i}>
          <text x={colW * i + colW / 2} y={12} textAnchor="middle" className="rw-tick">
            {i === 0 ? "Today" : dayName(i)}
          </text>
          <line
            x1={colW * i + colW / 2}
            x2={colW * i + colW / 2}
            y1={TOP}
            y2={H - BOTTOM}
            pathLength={1}
            className="rw-day rw-draw"
            style={{ ["--i" as string]: i }}
          />
        </g>
      ))}
      {[
        [0.25, "6:00"],
        [0.5, "12:00"],
        [0.75, "18:00"],
      ].map(([f, label]) => {
        const y = TOP + (f as number) * (H - TOP - BOTTOM);
        return (
          <g key={label}>
            <line x1={0} x2={W} y1={y} y2={y} className="rw-hour" />
            <text x={W + 8} y={y + 4} className="rw-tick">
              {label}
            </text>
          </g>
        );
      })}
      {/* Now, on today's column: where the week is read from. */}
      <line x1={colW * 0.18} x2={colW * 0.82} y1={nowY} y2={nowY} className="rw-now rw-pop" style={{ ["--i" as string]: 3 }} />

      {soonest && (
        <path
          d={`M ${colW / 2} ${nowY} L ${place(soonest.at).x} ${place(soonest.at).y}`}
          pathLength={1}
          className="rw-trajectory rw-draw"
          style={{ ["--i" as string]: 8 }}
        />
      )}
      {points.map(({ s, at }, i) => {
        const p = place(at);
        const live = soonest?.s.id === s.id;
        return (
          <g key={s.id} className="rw-pop" style={{ ["--i" as string]: i + 4 }}>
            <title>{`${s.name}, ${new Date(at).toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" })}`}</title>
            {live && <circle cx={p.x} cy={p.y} r={10} className="rw-ring rw-breathe" />}
            <circle cx={p.x} cy={p.y} r={live ? 4 : 3.5} className={live ? "rw-point rw-live" : "rw-point"} />
            {live && (
              <text
                x={p.x + (p.x > W * 0.7 ? -14 : 14)}
                y={p.y + 4}
                textAnchor={p.x > W * 0.7 ? "end" : "start"}
                className="rw-label"
              >
                {s.name.length > 26 ? `${s.name.slice(0, 25)}…` : s.name}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

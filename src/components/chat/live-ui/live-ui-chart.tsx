"use client";

import * as React from "react";
import type { LiveFormatter, LiveFormat } from "@/lib/live-ui/format";
import { liveRange, type LiveScope, type LiveValue } from "@/lib/live-ui/expr";
import type { LiveComponent } from "@/lib/live-ui/spec";
import { cn } from "@/lib/utils";

type ChartSpec = Extract<LiveComponent, { type: "chart" }>;

const MAX_POINTS = 400;
const PLOT_HEIGHT = 188;

export interface ChartData {
  xs: (number | string)[];
  series: { label: string; ys: (number | null)[] }[];
  numericX: boolean;
  /** The marked x, when the chart has one and it evaluates. */
  mark?: number | null;
  error?: string;
}

/** Evaluate a chart against the scope: x range or rows, then each series. */
export function chartData(chart: ChartSpec, scope: LiveScope): ChartData {
  const series = chart.series.map((s) => ({ label: s.label, ys: [] as (number | null)[] }));
  const num = (src: string) => {
    const v = scope.evaluate(src).value;
    return typeof v === "number" ? v : null;
  };
  if (chart.x) {
    const from = num(chart.x.from);
    const to = num(chart.x.to);
    const step = num(chart.x.step);
    if (from === null || to === null || step === null) return { xs: [], series, numericX: true, error: "The chart's range could not be worked out." };
    let xs: number[] | null;
    try {
      xs = liveRange(from, to, step);
    } catch {
      xs = null;
    }
    if (!xs || xs.length > MAX_POINTS) return { xs: [], series, numericX: true, error: "The chart's range is too long to draw." };
    for (const x of xs) {
      chart.series.forEach((s, i) => {
        const v = scope.evaluate(s.y, { [chart.x!.variable]: x }).value;
        series[i].ys.push(typeof v === "number" ? v : null);
      });
    }
    const mark = chart.mark ? num(chart.mark) : null;
    return { xs, series, numericX: true, mark };
  }
  const rows = scope.evaluate(chart.rows ?? "").value;
  if (!Array.isArray(rows)) return { xs: [], series, numericX: false, error: "The chart has no rows to draw." };
  const xs: (number | string)[] = [];
  rows.slice(0, MAX_POINTS).forEach((row, index) => {
    const locals: Record<string, LiveValue> =
      row !== null && typeof row === "object" && !Array.isArray(row) ? { ...row, row, index } : { value: row, row, index };
    const xv = chart.xKey === "index" ? index + 1 : scope.evaluate(chart.xKey ?? "index", locals).value;
    xs.push(typeof xv === "number" || typeof xv === "string" ? xv : String(index + 1));
    chart.series.forEach((s, i) => {
      const v = scope.evaluate(s.y, locals).value;
      series[i].ys.push(typeof v === "number" ? v : null);
    });
  });
  return { xs, series, numericX: false };
}

/** Round tick steps (1, 2, 2.5, 5 × 10^n) — four or five gridlines. */
function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) {
    const pad = Math.abs(min) || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.5 && ticks.length < 8; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

const SERIES_STROKE = ["hsl(var(--primary))", "hsl(var(--foreground) / 0.62)", "hsl(var(--foreground) / 0.42)", "hsl(var(--foreground) / 0.3)"];
const SERIES_DASH = [undefined, undefined, "4 3", "1.5 3"];

/**
 * A chart bound to formulas, drawn in SVG (the web has no chart library and a
 * 400-point line does not need one).
 *
 * One accent: the first series is the product's primary; the rest are the
 * ink at falling strengths, told apart by dash rather than by hue, so a chart
 * never brings a palette into a calm transcript. The readout above the plot is
 * the chart's voice: at rest it states the last point (where the plan ends),
 * under the pointer or the arrow keys it states the point under the rule.
 */
export function LiveChart({
  chart,
  scope,
  formatter,
  currency,
}: {
  chart: ChartSpec;
  scope: LiveScope;
  formatter: LiveFormatter;
  currency: string;
}) {
  const data = React.useMemo(() => chartData(chart, scope), [chart, scope]);
  const ref = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(560);
  const [active, setActive] = React.useState<number | null>(null);
  const clipId = `live-clip-${React.useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.round(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** The readout says the exact value; the axis says a short one. */
  const fmtY = (v: number, axis = false) => {
    const format = chart.format ?? "number";
    if (!axis) {
      // Small plain numbers (densities, rates) need significant digits, not two decimals.
      const small = format === "number" && v !== 0 && Math.abs(v) < 1;
      return formatter.number(v, format, { currency, digits: small ? Math.min(6, 2 - Math.floor(Math.log10(Math.abs(v)))) : undefined });
    }
    if (format === "percent") return formatter.number(v, "percent", { digits: 0 });
    if (format === "currency" && Math.abs(v) < 10_000) return formatter.number(v, "currency", { currency, digits: 0 });
    return formatter.number(v, Math.abs(v) >= 10_000 ? "compact" : "number", { currency });
  };
  const fmtX = (x: number | string) => (typeof x === "number" ? formatter.number(x, chart.xFormat ?? "number", { currency }) : x);

  if (data.error || data.xs.length === 0) {
    return (
      <figure className="flex flex-col gap-2">
        {chart.title ? <figcaption className="text-ui font-medium">{chart.title}</figcaption> : null}
        <p className="text-ui text-muted-foreground">{data.error ?? "Nothing to draw yet."}</p>
      </figure>
    );
  }

  const all = data.series.flatMap((s) => s.ys.filter((v): v is number => v !== null));
  const yMin = Math.min(0, ...all);
  const yMax = Math.max(0, ...all);
  const ticks = niceTicks(yMin, yMax);
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const labelW = Math.max(28, Math.max(...ticks.map((t) => fmtY(t, true).length)) * 7.6 + 12); // caption digits are ~7.3px; the old 6.6 clipped "100%" at phone width
  const padL = labelW;
  const padR = 8;
  const padT = 8;
  const padB = 22;
  const plotW = width - padL - padR;
  const n = data.xs.length;
  const band = chart.kind === "bar" || !data.numericX;
  const x0 = data.numericX ? (data.xs[0] as number) : 0;
  const x1 = data.numericX ? (data.xs[n - 1] as number) : 0;
  const xPos = (x: number) => padL + (x1 === x0 ? plotW / 2 : (plotW * (x - x0)) / (x1 - x0));
  const xAt = (i: number) =>
    band ? padL + (plotW * (i + 0.5)) / n : data.numericX ? xPos(data.xs[i] as number) : padL + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1));
  const markX = !band && data.numericX && typeof data.mark === "number" && data.mark >= Math.min(x0, x1) && data.mark <= Math.max(x0, x1) ? data.mark : null;
  const yAt = (v: number) => padT + PLOT_HEIGHT * (1 - (v - lo) / (hi - lo || 1));
  const restIndex =
    markX !== null
      ? data.xs.reduce<number>((best, x, i) => (Math.abs((x as number) - markX) < Math.abs((data.xs[best] as number) - markX) ? i : best), 0)
      : n - 1;
  const shown = active ?? restIndex;
  // Numeric axes get round ticks (-4, -2, 0, 2, 4), not every k-th sample.
  const xTicks = !band && data.numericX ? niceTicks(Math.min(x0, x1), Math.max(x0, x1), Math.max(3, Math.floor(plotW / 70))).filter((t) => t >= Math.min(x0, x1) - 1e-9 && t <= Math.max(x0, x1) + 1e-9) : null;

  const areaFor = (ys: (number | null)[]) =>
    `${pathFor(ys)}L${xAt(lastIndex(ys)).toFixed(1)},${yAt(Math.max(lo, 0)).toFixed(1)}L${xAt(firstIndex(ys)).toFixed(1)},${yAt(Math.max(lo, 0)).toFixed(1)}Z`;
  const pathFor = (ys: (number | null)[]) => {
    let d = "";
    let pen = false;
    ys.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  const xTickEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 72))));
  const onPointer = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left - padL;
    const i = band ? Math.floor((x / plotW) * n) : Math.round((x / plotW) * (n - 1));
    setActive(Math.max(0, Math.min(n - 1, i)));
  };

  const barW = Math.max(2, Math.min(36, (plotW / n) * 0.62 / data.series.length));

  return (
    <figure className="flex min-w-0 flex-col gap-2.5" ref={ref}>
      <figcaption className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        {chart.title ? <span className="text-ui font-medium text-foreground">{chart.title}</span> : <span />}
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 text-ui tabular-nums" aria-live="polite">
          <span className="text-muted-foreground">
            {chart.x?.label ? `${chart.x.label} ` : ""}
            {fmtX(data.xs[shown])}
          </span>
          {data.series.map((s, i) => (
            <span key={i} className="inline-flex items-baseline gap-1.5">
              {data.series.length > 1 ? (
                <svg width="14" height="6" aria-hidden className="self-center">
                  <line x1="0" y1="3" x2="14" y2="3" stroke={SERIES_STROKE[i]} strokeWidth="2" strokeDasharray={SERIES_DASH[i]} />
                </svg>
              ) : null}
              {s.label ? <span className="text-muted-foreground">{s.label}</span> : null}
              <span className="font-medium text-foreground">{s.ys[shown] === null ? "–" : fmtY(s.ys[shown]!)}</span>
            </span>
          ))}
        </span>
      </figcaption>
      <svg
        width={width}
        height={PLOT_HEIGHT + padT + padB}
        className="max-w-full touch-pan-y select-none overflow-visible outline-none"
        role="img"
        tabIndex={0}
        aria-label={`${chart.title ?? "Chart"}: ${data.series.map((s) => s.label || "value").join(", ")} across ${n} points. Use the arrow keys to read values.`}
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerLeave={() => setActive(null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault();
            setActive((a) => Math.max(0, Math.min(n - 1, (a ?? n - 1) + (e.key === "ArrowRight" ? 1 : -1))));
          } else if (e.key === "Home") setActive(0);
          else if (e.key === "End") setActive(n - 1);
        }}
        onBlur={() => setActive(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={width - padR} y1={yAt(t)} y2={yAt(t)} stroke="hsl(var(--border))" strokeOpacity={t === 0 ? 1 : 0.6} strokeWidth={1} />
            <text x={padL - 8} y={yAt(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-caption tabular-nums">
              {fmtY(t, true)}
            </text>
          </g>
        ))}
        {xTicks
          ? xTicks.map((t) => (
              <text key={`t${t}`} x={xPos(t)} y={PLOT_HEIGHT + padT + 16} textAnchor="middle" className="fill-muted-foreground text-caption tabular-nums">
                {fmtX(t)}
              </text>
            ))
          : data.xs.map((x, i) =>
          i % xTickEvery === 0 || (i === n - 1 && !band && (n - 1) % xTickEvery > xTickEvery / 2) ? (
            <text key={i} x={xAt(i)} y={PLOT_HEIGHT + padT + 16} textAnchor="middle" className="fill-muted-foreground text-caption tabular-nums">
              {String(fmtX(x)).slice(0, 14)}
            </text>
          ) : null,
        )}
        {band
          ? data.series.map((s, si) =>
              s.ys.map((v, i) =>
                v === null ? null : (
                  <rect
                    key={`${si}-${i}`}
                    x={xAt(i) - (barW * data.series.length) / 2 + si * barW}
                    y={Math.min(yAt(v), yAt(0))}
                    width={barW - 1}
                    height={Math.max(1, Math.abs(yAt(0) - yAt(v)))}
                    rx={Math.min(3, barW / 3)}
                    fill={si === 0 ? "hsl(var(--primary))" : SERIES_STROKE[si]}
                    fillOpacity={active === null || active === i ? (si === 0 ? 0.85 : 1) : 0.4}
                    className="transition-[fill-opacity] duration-fast motion-reduce:transition-none"
                  />
                ),
              ),
            )
          : data.series.map((s, si) => (
              <g key={si}>
                {chart.kind === "area" && si === 0 ? (
                  <>
                    <path d={areaFor(s.ys)} fill="hsl(var(--primary) / 0.08)" />
                    {markX !== null ? (
                      <>
                        <clipPath id={clipId}>
                          <rect x={padL} y={padT} width={Math.max(0, xPos(markX) - padL)} height={PLOT_HEIGHT} />
                        </clipPath>
                        <path d={areaFor(s.ys)} fill="hsl(var(--primary) / 0.2)" clipPath={`url(#${clipId})`} />
                      </>
                    ) : null}
                  </>
                ) : null}
                <path d={pathFor(s.ys)} fill="none" stroke={SERIES_STROKE[si]} strokeWidth={si === 0 ? 2 : 1.5} strokeDasharray={SERIES_DASH[si]} strokeLinejoin="round" strokeLinecap="round" />
              </g>
            ))}
        {markX !== null ? (
          <line x1={xPos(markX)} x2={xPos(markX)} y1={padT} y2={padT + PLOT_HEIGHT} stroke="hsl(var(--foreground) / 0.55)" strokeWidth={1} strokeDasharray="3 3" aria-hidden />
        ) : null}
        {!band ? (
          <g className={cn(active === null && "opacity-0")} aria-hidden>
            <line x1={xAt(shown)} x2={xAt(shown)} y1={padT} y2={padT + PLOT_HEIGHT} stroke="hsl(var(--foreground) / 0.25)" strokeWidth={1} />
            {data.series.map((s, si) =>
              s.ys[shown] === null ? null : (
                <circle key={si} cx={xAt(shown)} cy={yAt(s.ys[shown]!)} r={3.5} fill="hsl(var(--background))" stroke={SERIES_STROKE[si]} strokeWidth={2} />
              ),
            )}
          </g>
        ) : null}
      </svg>
    </figure>
  );
}

function firstIndex(ys: (number | null)[]): number {
  const i = ys.findIndex((v) => v !== null);
  return i < 0 ? 0 : i;
}

function lastIndex(ys: (number | null)[]): number {
  for (let i = ys.length - 1; i >= 0; i--) if (ys[i] !== null) return i;
  return 0;
}

export type { LiveFormat };

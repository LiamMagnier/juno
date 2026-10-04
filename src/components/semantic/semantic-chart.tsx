"use client";

import * as React from "react";

/**
 * One small, honest SVG chart for workbook charts and deck charts: bar,
 * column, line, area, pie. Drawn from the computed values, so a recalculated
 * input redraws it. Ink for the first series, presence blue for the second,
 * then muted tones; a legend only when there is more than one series.
 */

export type SemanticChartType = "bar" | "column" | "line" | "pie" | "area";

export interface SemanticChartProps {
  type: SemanticChartType;
  title?: string;
  categories: string[];
  series: { name: string; values: (number | null)[] }[];
  /** CSS colour overrides (a deck's theme). */
  ink?: string;
  accent?: string;
  muted?: string;
  height?: number;
  compact?: boolean;
}

const PALETTE = ["var(--sx-ink, hsl(var(--foreground) / 0.82))", "var(--sx-presence)", "hsl(var(--muted-foreground))", "var(--sx-attention)", "hsl(var(--foreground) / 0.4)"];

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const steps = [1, 2, 2.5, 5, 10];
  const step = steps.find((s) => s * magnitude >= value) ?? 10;
  return step * magnitude;
}

function short(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function SemanticChart({ type, title, categories, series, ink, accent, muted, height = 220, compact = false }: SemanticChartProps) {
  const id = React.useId();
  const colors = PALETTE.map((c, i) => (i === 0 && ink ? ink : i === 1 && accent ? accent : i === 2 && muted ? muted : c));
  const width = 480;
  const pad = compact ? { l: 28, r: 8, t: 8, b: 18 } : { l: 44, r: 12, t: 12, b: 28 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const values = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const max = niceMax(Math.max(0, ...values));
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const y = (v: number) => pad.t + plotH - ((v - min) / span) * plotH;
  const label = `${title ?? "Chart"}: ${series.map((s) => `${s.name} ${s.values.map((v) => (v === null ? "–" : short(v))).join(", ")}`).join("; ")}`;
  const fontSize = compact ? 9 : 11;

  if (type === "pie") {
    const data = series[0]?.values.map((v) => Math.max(0, v ?? 0)) ?? [];
    const total = data.reduce((a, b) => a + b, 0) || 1;
    const r = Math.min(plotH, plotW) / 2;
    const cx = width / 2;
    const cy = pad.t + plotH / 2;
    let angle = -Math.PI / 2;
    return (
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} className="block h-auto w-full">
        {data.map((value, i) => {
          const sweep = (value / total) * Math.PI * 2;
          const a0 = angle;
          const a1 = angle + sweep;
          angle = a1;
          const large = sweep > Math.PI ? 1 : 0;
          const path = `M${cx},${cy} L${cx + r * Math.cos(a0)},${cy + r * Math.sin(a0)} A${r},${r} 0 ${large} 1 ${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)} Z`;
          return <path key={i} d={path} fill={colors[i % colors.length]} stroke="hsl(var(--background))" strokeWidth={1.5} />;
        })}
        {!compact &&
          categories.map((category, i) => (
            <text key={i} x={pad.l - 36} y={pad.t + 12 + i * 15} fontSize={fontSize} fill="hsl(var(--muted-foreground))" fontFamily="var(--font-mono)">
              <tspan fill={colors[i % colors.length]}>■ </tspan>
              {category}
            </text>
          ))}
      </svg>
    );
  }

  const horizontal = type === "bar";
  const n = Math.max(1, categories.length);
  const band = (horizontal ? plotH : plotW) / n;
  const ticks = [0, 0.5, 1].map((t) => min + span * t);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} className="block h-auto w-full">
      <defs>
        <clipPath id={`${id}-plot`}>
          <rect x={pad.l} y={pad.t} width={plotW} height={plotH} />
        </clipPath>
      </defs>
      {!horizontal &&
        ticks.map((t, i) => (
          <g key={i}>
            <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke="var(--sx-hair)" />
            <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" fontSize={fontSize} fill="hsl(var(--muted-foreground))" fontFamily="var(--font-mono)">
              {short(t)}
            </text>
          </g>
        ))}
      {categories.map((category, i) => {
        if (compact && n > 6 && i % Math.ceil(n / 6) !== 0) return null;
        return horizontal ? (
          <text key={i} x={pad.l - 6} y={pad.t + band * (i + 0.5) + 3} textAnchor="end" fontSize={fontSize} fill="hsl(var(--muted-foreground))" fontFamily="var(--font-mono)">
            {category.slice(0, 10)}
          </text>
        ) : (
          <text key={i} x={pad.l + band * (i + 0.5)} y={height - pad.b + 14} textAnchor="middle" fontSize={fontSize} fill="hsl(var(--muted-foreground))" fontFamily="var(--font-mono)">
            {category.slice(0, 8)}
          </text>
        );
      })}
      <g clipPath={`url(#${id}-plot)`}>
        {(type === "column" || type === "bar") &&
          series.map((s, si) =>
            s.values.map((value, i) => {
              if (value === null) return null;
              const inner = (band * 0.72) / series.length;
              const offset = band * 0.14 + inner * si;
              if (horizontal) {
                const x0 = pad.l + ((0 - min) / span) * plotW;
                const x1 = pad.l + ((value - min) / span) * plotW;
                return <rect key={`${si}-${i}`} x={Math.min(x0, x1)} y={pad.t + band * i + offset} width={Math.abs(x1 - x0)} height={inner} fill={colors[si % colors.length]} />;
              }
              return (
                <rect
                  key={`${si}-${i}`}
                  x={pad.l + band * i + offset}
                  y={Math.min(y(value), y(0))}
                  width={inner}
                  height={Math.abs(y(0) - y(value))}
                  fill={colors[si % colors.length]}
                />
              );
            })
          )}
        {(type === "line" || type === "area") &&
          series.map((s, si) => {
            const points = s.values
              .map((value, i) => (value === null ? null : ([pad.l + band * (i + 0.5), y(value)] as const)))
              .filter((p): p is readonly [number, number] => p !== null);
            if (!points.length) return null;
            const line = points.map(([px, py], i) => `${i ? "L" : "M"}${px},${py}`).join(" ");
            const color = colors[si % colors.length];
            return (
              <g key={si}>
                {type === "area" && (
                  <path d={`${line} L${points.at(-1)![0]},${y(0)} L${points[0][0]},${y(0)} Z`} fill={color} fillOpacity={0.16} />
                )}
                <path d={line} fill="none" stroke={color} strokeWidth={compact ? 1.5 : 2} strokeLinejoin="round" />
                {!compact && points.map(([px, py], i) => <circle key={i} cx={px} cy={py} r={2.5} fill={color} />)}
              </g>
            );
          })}
      </g>
      {!compact && series.length > 1 && (
        <g>
          {series.map((s, si) => (
            <text key={si} x={pad.l + si * 110} y={height - 2} fontSize={fontSize} fill="hsl(var(--muted-foreground))" fontFamily="var(--font-mono)">
              <tspan fill={colors[si % colors.length]}>■ </tspan>
              {s.name.slice(0, 14)}
            </text>
          ))}
        </g>
      )}
    </svg>
  );
}

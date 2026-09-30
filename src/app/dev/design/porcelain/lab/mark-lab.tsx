import * as React from "react";
import { RefreshCw } from "@/components/ui/icons";

function arc(r: number, from: number, to: number) {
  const p = (d: number) => [12 + r * Math.cos((d * Math.PI) / 180), 12 + r * Math.sin((d * Math.PI) / 180)];
  const [sx, sy] = p(from);
  const [ex, ey] = p(to);
  return `M${sx.toFixed(3)} ${sy.toFixed(3)} A${r} ${r} 0 1 1 ${ex.toFixed(3)} ${ey.toFixed(3)}`;
}

const V = [
  { id: "a", name: "gap 70 upper-right (p1)", r: 8.25, gap: 70, at: -45, dot: 2.6, full: false },
  { id: "b", name: "full circle, bead at -45", r: 8.25, gap: 0, at: -45, dot: 2.6, full: true },
  { id: "c", name: "gap 44 centred, dot -45", r: 8.25, gap: 44, at: -45, dot: 2.4, full: false },
  { id: "d", name: "gap 44 at 3 o'clock", r: 8.25, gap: 44, at: 0, dot: 2.4, full: false },
  { id: "e", name: "gap 44 at 1 o'clock, r 8.75", r: 8.75, gap: 44, at: -60, dot: 2.5, full: false },
  { id: "f", name: "full circle, bead at -60, dot 3", r: 8.25, gap: 0, at: -60, dot: 3, full: true },
];

export function MarkLab({ ink, bg, sig }: { ink: string; bg: string; sig: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 28, padding: 40, background: bg, color: ink }}>
      {V.map((v) => {
        const d = v.full ? `M${12 + v.r} 12 A${v.r} ${v.r} 0 1 1 ${12 + v.r} 11.999` : arc(v.r, v.at + v.gap / 2, v.at - v.gap / 2);
        const [dx, dy] = [12 + v.r * Math.cos((v.at * Math.PI) / 180), 12 + v.r * Math.sin((v.at * Math.PI) / 180)];
        const svg = (s: number) => (
          <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
            <path d={d} stroke={ink} strokeWidth={1.35} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            <circle cx={dx} cy={dy} r={v.dot} fill={sig} />
          </svg>
        );
        return (
          <div key={v.id} style={{ display: "flex", alignItems: "center", gap: 20, fontSize: 13 }}>
            {svg(16)}
            {svg(20)}
            {svg(44)}
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 16.5, fontWeight: 500 }}>
              {svg(20)} Juno
            </span>
            <span style={{ opacity: 0.6 }}>{v.name}</span>
          </div>
        );
      })}
      <div style={{ display: "flex", alignItems: "center", gap: 20, fontSize: 13 }}>
        <RefreshCw style={{ width: 20, height: 20 }} /> <span style={{ opacity: 0.6 }}>refresh icon, for comparison</span>
      </div>
    </div>
  );
}

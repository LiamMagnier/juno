"use client";

import * as React from "react";

/*
 * The homepage construction (construction.tsx) rendered as ASCII, for a
 * side-by-side look against the hairline version. Same geometry: seven nested
 * orbits at a 1.5 ratio and 0.34 flattening on a 1500 × 1000 drawing, the
 * number line through the centre, ℵ ticks, one presence trajectory on the
 * fourth orbit ending on a node.
 *
 *   line     each orbit traced with characters that follow its slope
 *   density  characters graded by nearness to an orbit, so lines glow softly
 *
 * The drawing is placed exactly as the access panel places it (190% of the
 * panel's width, 3:2, centred at 50% / 46%), and draws itself in once.
 */

const CX = 750;
const CY = 500;
const BASE = 132;
const RATIO = 1.5;
const FLAT = 0.34;
const COUNT = 7;
const ORBITS = Array.from({ length: COUNT }, (_, k) => {
  const rx = BASE * RATIO ** k;
  return { rx, ry: rx * FLAT };
});
const TRAJ = { orbit: 3, from: 305, to: 376 };

type Cell = { ch: string; tone: "ink" | "faint" | "blue" | "tick"; at: number };
const SLOPE = ["-", "\\", "|", "/"];
const DENSITY = " .·:-=+*";

function slopeChar(dx: number, dy: number) {
  // Character cells are ~2× taller than wide: stretch y before reading the angle.
  const angle = Math.atan2(dy * 2, dx);
  const index = Math.round(((angle + Math.PI) / Math.PI) * 4) % 4;
  return SLOPE[index];
}

export function AsciiConstruction({
  variant,
  cols,
  rows,
  panel,
}: {
  variant: "line" | "density";
  cols: number;
  rows: number;
  /** The panel's size in px, to place the drawing as the real panel does. */
  panel: { w: number; h: number };
}) {
  const grid = React.useMemo(() => {
    const cells: (Cell | null)[] = Array.from({ length: cols * rows }, () => null);
    const cw = panel.w / cols;
    const rh = panel.h / rows;
    // Drawing box in panel px.
    const bw = panel.w * 1.9;
    const bh = (bw * 2) / 3;
    const bx = panel.w * 0.5 - bw / 2;
    const by = panel.h * 0.46 - bh / 2;
    const toCell = (x: number, y: number) => {
      const px = bx + (x / 1500) * bw;
      const py = by + (y / 1000) * bh;
      const c = Math.floor(px / cw);
      const r = Math.floor(py / rh);
      return c >= 0 && c < cols && r >= 0 && r < rows ? r * cols + c : -1;
    };
    const put = (i: number, cell: Cell, force = false) => {
      if (i < 0) return;
      if (!cells[i] || force) cells[i] = cell;
    };

    if (variant === "line") {
      // Axis.
      for (let x = 0; x <= 1500; x += 2) put(toCell(x, CY), { ch: "·", tone: "faint", at: 0 });
      ORBITS.forEach(({ rx, ry }, k) => {
        const steps = 1400;
        for (let s = 0; s < steps; s++) {
          const t = (s / steps) * Math.PI * 2;
          const x = CX + rx * Math.cos(t);
          const y = CY + ry * Math.sin(t);
          const ch = k >= 5 ? "." : slopeChar(-rx * Math.sin(t), ry * Math.cos(t));
          put(toCell(x, y), { ch, tone: k >= 5 ? "faint" : "ink", at: (k + 1) * 0.11 + (s / steps) * 0.9 }, true);
        }
      });
    } else {
      // Density: for each cell, nearness to the closest orbit, graded.
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const px = (c + 0.5) * cw;
          const py = (r + 0.5) * rh;
          const x = ((px - bx) / bw) * 1500;
          const y = ((py - by) / bh) * 1000;
          let best = Infinity;
          let bestK = 0;
          ORBITS.forEach(({ rx, ry }, k) => {
            // First-order distance to the ellipse: |G − 1| / |∇G|, with
            // G = (dx/rx)² + (dy/ry)², in drawing units.
            const dx = x - CX;
            const dy = y - CY;
            const g = (dx / rx) ** 2 + (dy / ry) ** 2;
            const grad = Math.hypot((2 * dx) / rx ** 2, (2 * dy) / ry ** 2) || 1e-6;
            const d = Math.abs(g - 1) / grad;
            if (d < best) {
              best = d;
              bestK = k;
            }
          });
          const unitX = (1500 / bw) * cw; // one cell's width in drawing units
          const unitY = (1000 / bh) * rh; // and its height
          const v = Math.max(0, 1 - best / (Math.min(unitX, unitY) * 1.4));
          const axis = Math.max(0, 1 - Math.abs(y - CY) / (unitY * 0.6)) * 0.3;
          const level = Math.max(bestK >= 5 ? v * 0.5 : v, axis);
          const idx = Math.round(level * (DENSITY.length - 1));
          if (idx > 0) {
            const angle = Math.atan2(y - CY, x - CX);
            cells[r * cols + c] = {
              ch: DENSITY[idx],
              tone: bestK >= 5 || level === axis ? "faint" : "ink",
              at: (bestK + 1) * 0.11 + ((angle + Math.PI) / (2 * Math.PI)) * 0.9,
            };
          }
        }
      }
    }

    // ℵ ticks on the number line, right of the first five orbits.
    ORBITS.slice(0, 5).forEach(({ rx }, k) => {
      const i = toCell(CX + rx + 14, CY - 14);
      put(i, { ch: "ℵ", tone: "tick", at: 1.3 + k * 0.11 }, true);
      const sub = "₀₁₂₃₄"[k];
      if (i >= 0 && (i + 1) % cols !== 0) put(i + 1, { ch: sub, tone: "tick", at: 1.3 + k * 0.11 }, true);
    });

    // The trajectory and its node, in presence blue.
    const o = ORBITS[TRAJ.orbit];
    const span = TRAJ.to - TRAJ.from;
    for (let s = 0; s <= 400; s++) {
      const deg = TRAJ.from + (s / 400) * span;
      const t = (deg * Math.PI) / 180;
      const x = CX + o.rx * Math.cos(t);
      const y = CY + o.ry * Math.sin(t);
      const ch = variant === "line" ? slopeChar(-o.rx * Math.sin(t), o.ry * Math.cos(t)) : "*";
      put(toCell(x, y), { ch, tone: "blue", at: 0.9 + (s / 400) * 1.1 }, true);
    }
    const end = (TRAJ.to * Math.PI) / 180;
    put(toCell(CX + o.rx * Math.cos(end), CY + o.ry * Math.sin(end)), { ch: "@", tone: "blue", at: 2.1 }, true);
    return cells;
  }, [variant, cols, rows, panel.w, panel.h]);

  // Draw on arrival: cells appear when the clock passes their `at`.
  const [clock, setClock] = React.useState(0);
  React.useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setClock(99);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = (now - start) / 1000;
      setClock(t);
      if (t < 2.6) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [variant]);

  const lines: React.ReactNode[] = [];
  for (let r = 0; r < rows; r++) {
    const spans: React.ReactNode[] = [];
    let run = "";
    let runTone: Cell["tone"] | "blank" = "blank";
    const flush = (key: string) => {
      if (!run) return;
      spans.push(
        <span key={key} className={runTone === "blank" ? undefined : `ascii-${runTone}`}>
          {run}
        </span>
      );
      run = "";
    };
    for (let c = 0; c < cols; c++) {
      const cell = grid[r * cols + c];
      const visible = cell && cell.at <= clock;
      const tone = visible ? cell.tone : "blank";
      const ch = visible ? cell.ch : " ";
      if (tone !== runTone) {
        flush(`${r}-${c}`);
        runTone = tone;
      }
      run += ch;
    }
    flush(`${r}-end`);
    lines.push(<div key={r}>{spans}</div>);
  }
  return (
    <pre className="ascii-field" aria-hidden="true">
      {lines}
    </pre>
  );
}

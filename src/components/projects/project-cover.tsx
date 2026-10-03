"use client";

import * as React from "react";
import { DotRings } from "@/components/home/dot-construction";
import type { ArcSpec, LineSpec, RingSpec } from "@/components/home/dot-scenes";

/**
 * A project's cover: a small vignette of the construction, drawn in the
 * shared dot matrix (dot-construction.tsx) and derived from the project's id,
 * so the same project always wears the same drawing and two projects rarely
 * wear the same one. Nested orbits at the 1.5 ratio, in one of three
 * arrangements (concentric on the number line, tangent like a shell, or drawn
 * from a corner and cropped by the frame); one spoke per folder; and on the
 * most recently touched project only, the presence trajectory, the one blue
 * thing on the page.
 *
 * The drawing settles and stops asking for frames; under reduced motion it is
 * drawn once. Hover motion (a slow drift of the art) is CSS on `.pj-cover-art`.
 */

/** The cover's box, width over height (the tile's `aspect-[16/7]`). */
const ASPECT = 16 / 7;
const RATIO = 1.5;

function hash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32: a small seeded generator, so a drawing is a pure function of the id. */
function seeded(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface CoverDrawing {
  rings: RingSpec[];
  lines: LineSpec[];
  arcs: ArcSpec[];
  start: number;
}

export function coverDrawing(id: string, folders: number, live: boolean, aspect = ASPECT): CoverDrawing {
  const rnd = seeded(hash(id));
  const pick = (lo: number, hi: number) => lo + (hi - lo) * rnd();
  const mode = Math.floor(rnd() * 3); // 0 concentric, 1 tangent, 2 corner
  const count = 3 + Math.floor(rnd() * 2);
  const flat = pick(0.3, 0.42);
  const outer = mode === 2 ? pick(0.46, 0.56) : pick(0.3, 0.36);
  const cx = mode === 2 ? (rnd() < 0.5 ? pick(0.2, 0.28) : pick(0.72, 0.8)) : pick(0.42, 0.58);
  const cy = mode === 2 ? pick(0.6, 0.7) : 0.5;
  const side = rnd() < 0.5 ? -1 : 1;

  const rings: RingSpec[] = [];
  for (let k = 0; k < count; k++) {
    const rx = outer / RATIO ** k;
    const ry = rx * aspect * flat;
    // Tangent: every ring touches the outermost at one flank, like a shell.
    const shift = mode === 1 ? side * (outer - rx) : 0;
    rings.push({ cx: cx + shift, cy, rx, ry, faint: k === 0 });
  }
  // Innermost first, so the draw-on grows outwards like the construction.
  rings.reverse();

  const lines: LineSpec[] = [];
  if (mode === 0) lines.push({ x1: 0.04, y1: cy, x2: 0.96, y2: cy, strength: 0.13 });
  const spokes = Math.min(5, folders);
  const base = pick(0, 360);
  const hub = rings[0];
  const rim = rings[rings.length - 1];
  for (let i = 0; i < spokes; i++) {
    const a = ((base + (360 / Math.max(spokes, 3)) * i + pick(-12, 12)) * Math.PI) / 180;
    // From the innermost ring out to the outermost, like a spoke from its hub.
    lines.push({
      x1: (hub.cx ?? 0.5) + hub.rx * Math.cos(a),
      y1: (hub.cy ?? 0.5) + hub.ry * Math.sin(a),
      x2: (rim.cx ?? 0.5) + rim.rx * Math.cos(a),
      y2: (rim.cy ?? 0.5) + rim.ry * Math.sin(a),
      strength: 0.42,
    });
  }

  const arcs: ArcSpec[] = [];
  if (live) {
    // On a ring the frame shows whole, ending on the side that faces the plate.
    const corner = mode === 2;
    const ring = corner ? 1 : Math.min(rings.length - 1, 1 + Math.floor(rnd() * 2));
    const to = corner ? (cx > 0.5 ? 200 : -20) + pick(-15, 15) : pick(-40, 40);
    arcs.push({ ring, from: to - 95, to });
  }
  return { rings, lines, arcs, start: Math.round(pick(120, 240)) };
}

export function ProjectCover({
  id,
  folders = 0,
  live = false,
  index = 0,
  aspect = ASPECT,
  className,
}: {
  id: string;
  /** Subfolders: one spoke each (five at most). */
  folders?: number;
  /** The most recently touched project: the only drawing with the trajectory. */
  live?: boolean;
  /** Its place in the grid, so covers draw on in the tiles' own order. */
  index?: number;
  /** The box's width over height, when it is not the tile's 16:7. */
  aspect?: number;
  className?: string;
}) {
  const drawing = React.useMemo(() => coverDrawing(id, folders, live, aspect), [id, folders, live, aspect]);
  return (
    <div className={className ? `pj-cover-art ${className}` : "pj-cover-art"} aria-hidden="true">
      <DotRings
        rings={drawing.rings}
        lines={drawing.lines}
        arcs={drawing.arcs}
        start={drawing.start}
        delay={0.25 + Math.min(index, 11) * 0.06}
        stagger={0.08}
        draw={1.4}
        className="pj-cover-dots"
      />
    </div>
  );
}

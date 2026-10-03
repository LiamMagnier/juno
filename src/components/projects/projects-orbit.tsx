"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { DotRings } from "@/components/home/dot-construction";
import type { FolderProject } from "@/components/projects/project-folders";
import { buildProjectForest, type ProjectTreeEntry } from "@/lib/projects/project-tree";

/**
 * The account's projects as the construction: nested orbits at the 1.5 ratio,
 * one orbit per level of folders. Top-level projects sit on the second orbit
 * (the first is the room the centre needs), their folders one orbit out, and
 * deeper folders on the outermost; a dotted spoke joins each folder to its
 * parent. The most recently touched project carries the presence trajectory,
 * the one live object in the frame.
 *
 * Real data, not decoration: every point is a project, and pressing one opens
 * it. Labels name the top level only; folders are named on hover.
 */

const W = 640;
const H = 360;
const CX = W / 2;
const CY = H / 2;
const BASE = 64;
const RATIO = 1.5;
const FLAT = 0.52;
const ORBITS = [0, 1, 2, 3].map((k) => {
  const rx = BASE * RATIO ** k;
  return { rx, ry: rx * FLAT };
});
const DOT_RINGS = ORBITS.map(({ rx, ry }, k) => ({ rx: rx / W, ry: ry / H, faint: k === 3 }));
/** Projects beyond this many top-level points share the drawing unlabelled. */
const LABELLED = 6;

function at(orbit: number, deg: number) {
  const { rx, ry } = ORBITS[orbit];
  const t = (deg * Math.PI) / 180;
  return { x: CX + rx * Math.cos(t), y: CY + ry * Math.sin(t) };
}

interface Point {
  id: string;
  name: string;
  orbit: number;
  deg: number;
  x: number;
  y: number;
  parent: { x: number; y: number } | null;
  top: boolean;
  r: number;
}

function place(projects: readonly FolderProject[]): Point[] {
  const forest = buildProjectForest(projects, (a, b) => (b.conversationCount ?? 0) - (a.conversationCount ?? 0));
  const out: Point[] = [];
  const span = 360 / Math.max(1, forest.length);
  const max = Math.max(1, ...projects.map((p) => p.conversationCount ?? 0));
  const radius = (p: FolderProject) => 2.5 + 3.5 * Math.sqrt((p.conversationCount ?? 0) / max);
  const walk = (entries: ProjectTreeEntry<FolderProject>[], center: number, width: number, parent: Point | null) => {
    entries.forEach((entry, i) => {
      const deg = entries.length === 1 ? center : center - width / 2 + (width / (entries.length - 1)) * i;
      const orbit = Math.min(3, entry.depth);
      const pos = at(orbit, deg);
      const point: Point = {
        id: entry.node.id,
        name: entry.node.name,
        orbit,
        deg,
        x: pos.x,
        y: pos.y,
        parent: parent ? { x: parent.x, y: parent.y } : null,
        top: entry.depth === 1,
        r: entry.depth === 1 ? radius(entry.node) : Math.max(2, radius(entry.node) * 0.7),
      };
      out.push(point);
      // Folders fan out around their parent's angle, narrower each level.
      walk(entry.children, deg, parent ? width * 0.7 : Math.min(44, span * 0.75), point);
    });
  };
  forest.forEach((entry, i) => walk([entry], -90 + 20 + span * i, 0, null));
  return out;
}

/* ─────────────────────────────── Labels ─────────────────────────────── */

const FONT = 13;
/** A mono glyph's advance (0.6em) plus the label's 0.02em tracking, in viewBox units. */
const ADVANCE = FONT * 0.62;
const MAX_CHARS = 20;

interface Label {
  x: number;
  y: number;
  anchor: "start" | "end" | "middle";
  text: string;
}
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const clip = (name: string) => (name.length > MAX_CHARS ? `${name.slice(0, MAX_CHARS - 1)}…` : name);

/** The four places a label can sit round its point, the outward side first. */
function candidates(p: Point): Label[] {
  const text = clip(p.name);
  const gap = p.r + 7;
  const right = Math.cos((p.deg * Math.PI) / 180) >= 0;
  const below = Math.sin((p.deg * Math.PI) / 180) >= 0;
  const side: Label[] = [
    { x: p.x + gap, y: p.y + 4, anchor: "start", text },
    { x: p.x - gap, y: p.y + 4, anchor: "end", text },
  ];
  const vertical: Label[] = [
    { x: p.x, y: p.y + gap + 9, anchor: "middle", text },
    { x: p.x, y: p.y - gap, anchor: "middle", text },
  ];
  if (!right) side.reverse();
  if (!below) vertical.reverse();
  return [side[0], vertical[0], vertical[1], side[1]];
}

function boxOf(l: Label): Box {
  const w = l.text.length * ADVANCE;
  const x0 = l.anchor === "start" ? l.x : l.anchor === "end" ? l.x - w : l.x - w / 2;
  return { x0: x0 - 3, y0: l.y - FONT + 1, x1: x0 + w + 3, y1: l.y + 4 };
}

const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/**
 * Greedy label placement: the live project first, then the busiest, each
 * taking the first of its four places that clears every other point and
 * every label already placed, and staying unlabelled (named on hover) when
 * none does. Nothing collides, at the cost of a name or two on a crowded map.
 */
function placeLabels(points: Point[], wanted: string[]): Map<string, Label> {
  const placed = new Map<string, Label>();
  const boxes: Box[] = [];
  const dots = points.map((p) => ({ id: p.id, box: { x0: p.x - p.r - 3, y0: p.y - p.r - 3, x1: p.x + p.r + 3, y1: p.y + p.r + 3 } }));
  const centre: Box = { x0: CX - 6, y0: CY - 6, x1: CX + 6, y1: CY + 6 };
  for (const id of wanted) {
    const p = points.find((q) => q.id === id);
    if (!p) continue;
    for (const label of candidates(p)) {
      const box = boxOf(label);
      if (box.x0 < 0 || box.x1 > W || box.y0 < 0 || box.y1 > H) continue;
      if (overlaps(box, centre)) continue;
      if (dots.some((d) => d.id !== id && overlaps(box, d.box))) continue;
      if (boxes.some((b) => overlaps(box, b))) continue;
      placed.set(id, label);
      boxes.push(box);
      break;
    }
  }
  return placed;
}

export function ProjectsOrbit({ projects }: { projects: readonly FolderProject[] }) {
  const router = useRouter();
  const points = React.useMemo(() => place(projects), [projects]);
  const liveId = React.useMemo(() => {
    let best: FolderProject | null = null;
    for (const p of projects) if (!best || (p.updatedAt ?? "") > (best.updatedAt ?? "")) best = p;
    return best?.id ?? null;
  }, [projects]);
  const live = points.find((p) => p.id === liveId) ?? null;
  const [peek, setPeek] = React.useState<string | null>(null);

  const lines = React.useMemo(
    () =>
      points.map((p) => {
        const from = p.parent ?? { x: CX, y: CY };
        return {
          x1: from.x / W,
          y1: from.y / H,
          x2: p.x / W,
          y2: p.y / H,
          strength: p.id === peek ? 0.48 : p.parent ? 0.24 : 0.12,
        };
      }),
    [points, peek]
  );
  const arcs = React.useMemo(() => (live ? [{ ring: live.orbit, from: live.deg - 60, to: live.deg }] : undefined), [live]);
  const labels = React.useMemo(() => {
    const top = points.filter((p) => p.top).map((p) => p.id);
    const order = liveId && top.includes(liveId) ? [liveId, ...top.filter((id) => id !== liveId)] : top;
    return placeLabels(points, order.slice(0, LABELLED));
  }, [points, liveId]);

  return (
    <div className="pj relative">
      <DotRings rings={DOT_RINGS} lines={lines} arcs={arcs} className="pj-dots" />
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="group"
        aria-label="Your projects and their folders"
        className="relative h-auto w-full overflow-visible"
        preserveAspectRatio="xMidYMid meet"
      >
        <circle cx={CX} cy={CY} r={3} aria-hidden="true" className="pj-center pj-pop" />
        {points.map((p, i) => {
          const isLive = p.id === liveId;
          const label = labels.get(p.id) ?? (peek === p.id ? candidates(p)[0] : null);
          return (
            <g
              key={p.id}
              role="link"
              tabIndex={0}
              aria-label={`Open ${p.name}`}
              className="pj-star"
              onClick={() => router.push(`/projects/${p.id}`)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  router.push(`/projects/${p.id}`);
                }
              }}
              onMouseEnter={() => setPeek(p.id)}
              onMouseLeave={() => setPeek((cur) => (cur === p.id ? null : cur))}
              onFocus={() => setPeek(p.id)}
              onBlur={() => setPeek((cur) => (cur === p.id ? null : cur))}
            >
              <circle cx={p.x} cy={p.y} r={14} className="pj-node-hit" />
              {isLive && <circle cx={p.x} cy={p.y} r={p.r + 6} className="pj-node-ring pj-breathe" aria-hidden="true" />}
              <circle
                cx={p.x}
                cy={p.y}
                r={p.r}
                className={`pj-node pj-pop ${isLive ? "pj-node-live" : ""}`}
                style={{ ["--i" as string]: i }}
                aria-hidden="true"
              />
              {label && (
                <text
                  x={label.x}
                  y={label.y}
                  textAnchor={label.anchor}
                  className={labels.has(p.id) ? "pj-label pj-pop" : "pj-label pj-label-peek"}
                  style={{ ["--i" as string]: i }}
                  aria-hidden="true"
                >
                  {label.text}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

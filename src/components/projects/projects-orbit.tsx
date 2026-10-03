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
  const topLabelled = new Set(points.filter((p) => p.top).slice(0, LABELLED).map((p) => p.id));

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
          const right = Math.cos((p.deg * Math.PI) / 180) >= 0;
          const isLive = p.id === liveId;
          const showLabel = topLabelled.has(p.id) || peek === p.id;
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
              {showLabel && (
                <text
                  x={p.x + (right ? p.r + 8 : -(p.r + 8))}
                  y={p.y + 4}
                  textAnchor={right ? "start" : "end"}
                  className="pj-label pj-pop"
                  style={{ ["--i" as string]: i }}
                  aria-hidden="true"
                >
                  {p.name.length > 22 ? `${p.name.slice(0, 21)}…` : p.name}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

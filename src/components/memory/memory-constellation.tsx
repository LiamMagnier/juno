"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";

/**
 * What Alevr remembers, drawn as the homepage's construction: nested orbits
 * at a 1.5 ratio around you, one point per topic. A topic's distance from the
 * centre is its rank (the topics Alevr knows most about sit closest), its size
 * is how many memories it holds. The one presence trajectory travels to the
 * topic of the most recent memory, the only live object in the frame.
 *
 * Real data, not decoration: every point is a topic in scope, and pressing one
 * takes the reader to it.
 */

export interface ConstellationTopic {
  id: string;
  label: string;
  count: number;
}

const W = 640;
const H = 360;
const CX = W / 2;
const CY = H / 2;
const BASE = 68;
const RATIO = 1.5;
const FLAT = 0.52;
const ORBITS = [0, 1, 2, 3].map((k) => {
  const rx = BASE * RATIO ** k;
  return { rx, ry: rx * FLAT };
});
/** How many topics the second and third orbits hold; the rest share the fourth. */
const CAPACITY = [2, 3];
/** Each orbit starts its points at a different angle so no two line up on a spoke. */
const PHASE = [0, 20, 100, 160];

function at(orbit: number, deg: number) {
  const { rx, ry } = ORBITS[orbit];
  const t = (deg * Math.PI) / 180;
  return { x: CX + rx * Math.cos(t), y: CY + ry * Math.sin(t) };
}

function arc(orbit: number, from: number, to: number, steps = 36) {
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const p = at(orbit, from + ((to - from) * i) / steps);
    pts.push(`${p.x.toFixed(2)} ${p.y.toFixed(2)}`);
  }
  return `M${pts.join("L")}`;
}

interface Placed extends ConstellationTopic {
  orbit: number;
  deg: number;
  x: number;
  y: number;
  r: number;
  right: boolean;
  /** Where the label's baseline sits, nudged apart from its neighbours. */
  labelY: number;
}

/** Labels on the same side keep at least this far apart, in viewBox units. */
const LABEL_GAP = 17;

function separate(points: Placed[]): Placed[] {
  for (const side of [true, false]) {
    const group = points.filter((p) => p.right === side).sort((a, b) => a.y - b.y);
    for (let i = 1; i < group.length; i++) {
      const prev = group[i - 1];
      if (group[i].labelY - prev.labelY < LABEL_GAP) group[i].labelY = prev.labelY + LABEL_GAP;
    }
  }
  return points;
}

function place(topics: ConstellationTopic[]): Placed[] {
  const ranked = [...topics].sort((a, b) => b.count - a.count);
  const max = Math.max(1, ...ranked.map((t) => t.count));
  // The innermost orbit stays empty: it is the room "you" needs at the centre.
  const rings: ConstellationTopic[][] = [[], [], [], []];
  ranked.forEach((topic, rank) => {
    const orbit = rank < CAPACITY[0] ? 1 : rank < CAPACITY[0] + CAPACITY[1] ? 2 : 3;
    rings[orbit].push(topic);
  });
  return separate(rings.flatMap((members, orbit) =>
    members.map((topic, i) => {
      const deg = PHASE[orbit] + (360 / members.length) * i;
      const p = at(orbit, deg);
      const right = Math.cos((deg * Math.PI) / 180) >= 0;
      return { ...topic, orbit, deg, x: p.x, y: p.y, r: 2.5 + 4 * Math.sqrt(topic.count / max), right, labelY: p.y + 4 };
    })
  ));
}

export function MemoryConstellation({
  topics,
  liveTopicId,
  activeId,
  onSelect,
  previews,
}: {
  topics: ConstellationTopic[];
  /** The newest few memories per topic, shown in the peek card on hover. */
  previews?: Record<string, string[]>;
  /** Topic of the most recent memory: where the trajectory ends. */
  liveTopicId: string | null;
  /** Topic the reader is on in the list below, lit here too. */
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const placed = React.useMemo(() => place(topics), [topics]);
  const live = placed.find((p) => p.id === liveTopicId) ?? null;
  const [peek, setPeek] = React.useState<string | null>(null);
  const peeked = placed.find((p) => p.id === peek) ?? null;

  return (
    <div className="relative">
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="group"
      aria-label="Your topics"
      className="h-auto w-full overflow-visible"
      preserveAspectRatio="xMidYMid meet"
    >
      {ORBITS.map(({ rx, ry }, k) => (
        <ellipse
          key={k}
          cx={CX}
          cy={CY}
          rx={rx}
          ry={ry}
          pathLength={1}
          aria-hidden="true"
          className={`mem-orbit mem-draw ${k === 3 ? "mem-orbit-faint" : ""}`}
          style={{ ["--i" as string]: k }}
        />
      ))}
      {live && (
        <path
          d={arc(live.orbit, live.deg - 64, live.deg)}
          pathLength={1}
          aria-hidden="true"
          className="mem-trajectory mem-draw"
          style={{ ["--i" as string]: 8 }}
        />
      )}

      <circle cx={CX} cy={CY} r={3} aria-hidden="true" className="mem-center mem-pop" />
      <text x={CX} y={CY + 20} textAnchor="middle" aria-hidden="true" className="mem-label mem-pop">
        you
      </text>

      {placed.map((p, i) => {
        const right = p.right;
        const isLive = p.id === liveTopicId;
        return (
          <g
            key={p.id}
            role="button"
            tabIndex={0}
            aria-label={`${p.label}, ${p.count} ${p.count === 1 ? "memory" : "memories"}`}
            data-active={activeId === p.id || undefined}
            className="mem-star mem-pop"
            style={{ ["--i" as string]: i + 2 }}
            onClick={() => onSelect(p.id)}
            onMouseEnter={() => setPeek(p.id)}
            onMouseLeave={() => setPeek((was) => (was === p.id ? null : was))}
            onFocus={() => setPeek(p.id)}
            onBlur={() => setPeek((was) => (was === p.id ? null : was))}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(p.id);
              }
            }}
          >
            <line x1={CX} y1={CY} x2={p.x} y2={p.y} className="mem-spoke" aria-hidden="true" />
            {isLive && (
              <>
                <circle cx={p.x} cy={p.y} r={p.r + 7} className="mem-node-ring mem-breathe" aria-hidden="true" />
                <circle cx={p.x} cy={p.y} r={p.r + 7} className="mem-node-ring" opacity={0.35} aria-hidden="true" />
              </>
            )}
            <circle cx={p.x} cy={p.y} r={p.r} className={isLive ? "mem-node mem-node-live" : "mem-node"} aria-hidden="true" />
            <circle cx={p.x} cy={p.y} r={Math.max(14, p.r + 8)} className="mem-node-hit" />
            <text
              x={p.x + (right ? p.r + 9 : -(p.r + 9))}
              y={p.labelY}
              textAnchor={right ? "start" : "end"}
              className="mem-label"
              aria-hidden="true"
            >
              {p.label}
              <tspan dx={6} opacity={0.6}>
                {p.count}
              </tspan>
            </text>
          </g>
        );
      })}
    </svg>

      {/* The peek: what a point holds, before the reader commits to going
          there. Anchored to the point, opening away from the centre. */}
      <AnimatePresence>
        {peeked && previews?.[peeked.id]?.length ? (
          <motion.div
            key={peeked.id}
            aria-hidden="true"
            initial={{ opacity: 0, y: 6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98, transition: { duration: 0.12 } }}
            transition={{ type: "spring", stiffness: 520, damping: 38 }}
            className="surface-float pointer-events-none absolute z-[2] w-64 rounded-card p-3"
            style={{
              left: `${(peeked.x / W) * 100}%`,
              top: `${(peeked.y / H) * 100}%`,
              translate: `${peeked.right ? "16px" : "calc(-100% - 16px)"} ${peeked.y > CY ? "calc(-100% + 8px)" : "-8px"}`,
              transformOrigin: `${peeked.right ? "left" : "right"} ${peeked.y > CY ? "bottom" : "top"}`,
            }}
          >
            <p className="flex items-baseline justify-between gap-3 text-ui font-medium text-foreground">
              <span>{peeked.label}</span>
              <span className="mem-annot">{peeked.count}</span>
            </p>
            <ul className="mt-2 space-y-1.5">
              {previews[peeked.id].map((text) => (
                <li key={text} className="line-clamp-2 text-caption text-muted-foreground">
                  {text}
                </li>
              ))}
            </ul>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

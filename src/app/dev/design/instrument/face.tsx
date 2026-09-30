"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import type { FaceEyes, FaceShape, FaceSpec, Presence } from "./fixtures";
import { PRESENCE_LABEL } from "./fixtures";

/*
 * A crew member's face, Instrument's cut of the real `AgentFace` geometry
 * (src/components/agents/agent-face.tsx, AGENTS.md §4.2b): the same six body
 * shapes and four eye cuts on the 64-unit grid, drawn FLAT (one tone, ink
 * eyes, no gradient, no ground shadow) so a face sits in a hairline UI like
 * every other mark.
 *
 * The face is the state indicator, so motion happens on EVENTS, never as an
 * idle loop (owner rule):
 *   - it blinks when it appears, when you point at it and when its state
 *     changes;
 *   - entering a state plays that state's gesture a fixed number of times
 *     (waiting: two small "over here" hops; working: a settle into the reading
 *     pose, three passes of the eyes, then still; thinking: two glances up),
 *     then holds the pose;
 *   - the pose (eye shape and gaze) carries the state after the motion stops.
 * Reduced motion keeps the poses and drops every gesture. State is always
 * also words: the label, or the name beside it.
 */

const SHAPE_EYES: Record<FaceShape, { eyes: [[number, number], [number, number]]; scale: number }> = {
  tile: { eyes: [[24, 32], [40, 32]], scale: 0.9 },
  halo: { eyes: [[25, 33], [39, 33]], scale: 0.85 },
  orb: { eyes: [[24, 31], [40, 31]], scale: 1 },
  pebble: { eyes: [[24, 32], [40, 32]], scale: 1 },
  capsule: { eyes: [[26, 29], [38, 29]], scale: 0.9 },
  petal: { eyes: [[26, 34], [42, 34]], scale: 1 },
};

const EYE_CUT: Record<FaceEyes, { w: number; h: number; r: number }> = {
  soft: { w: 7, h: 9, r: 2.5 },
  round: { w: 6.5, h: 6.5, r: 3.25 },
  tall: { w: 5, h: 11, r: 2.5 },
  wide: { w: 10, h: 5.5, r: 2.75 },
};

function Body({ shape }: { shape: FaceShape }) {
  switch (shape) {
    case "tile":
      return <path d="M21 6 H43 Q58 6 58 21 V43 Q58 58 43 58 H21 Q6 58 6 43 V21 Q6 6 21 6 Z" />;
    case "halo":
      return <path d="M32 4 C48 4 60 16 60 32 C60 48 48 60 32 60 C16 60 4 48 4 32 C4 16 16 4 32 4 Z" />;
    case "orb":
      return <circle cx={32} cy={33} r={26} />;
    case "pebble":
      return <rect x={6} y={9} width={52} height={48} rx={20} />;
    case "capsule":
      return <rect x={12} y={5} width={40} height={56} rx={20} />;
    case "petal":
      return <path d="M8 9 H34 C48 9 58 21 58 35 C58 49 47 59 33 59 C19 59 8 48 8 34 Z" />;
  }
}

export interface FaceProps {
  face: FaceSpec;
  presence?: Presence;
  size?: number;
  /** Plays event motion (blink on appear and hover, state gestures). Off for pictures of a choice. */
  live?: boolean;
  /** Name for the accessible label; omit when the name is printed beside the face. */
  name?: string;
  className?: string;
}

export function Face({ face, presence = "available", size = 20, live = true, name, className }: FaceProps) {
  const spec = SHAPE_EYES[face.shape];
  const cut = EYE_CUT[face.eyes];
  const w = cut.w * spec.scale;
  const h = cut.h * spec.scale;
  const r = cut.r * spec.scale;
  const ref = React.useRef<SVGSVGElement | null>(null);
  const label = name ? `${name}, ${PRESENCE_LABEL[presence].toLowerCase()}` : undefined;

  const blink = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.removeAttribute("data-blink");
    void el.getBoundingClientRect();
    el.setAttribute("data-blink", "");
    window.setTimeout(() => el.removeAttribute("data-blink"), 220);
  }, []);

  // Blink once on appearing, a beat after, so a column of faces does not blink in unison.
  React.useEffect(() => {
    if (!live) return;
    const t = window.setTimeout(blink, 500 + Math.round(Math.random() * 900));
    return () => window.clearTimeout(t);
  }, [live, blink]);

  // A change of state is seen: a blink and a one-shot settle.
  const previous = React.useRef(presence);
  React.useEffect(() => {
    if (!live || previous.current === presence) return;
    previous.current = presence;
    blink();
    const el = ref.current;
    if (!el) return;
    el.removeAttribute("data-react");
    void el.getBoundingClientRect();
    el.setAttribute("data-react", "");
    const t = window.setTimeout(() => el.removeAttribute("data-react"), 560);
    return () => window.clearTimeout(t);
  }, [presence, live, blink]);

  return (
    <svg
      ref={ref}
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      data-presence={presence}
      data-live={live ? "" : undefined}
      onPointerEnter={live ? blink : undefined}
      className={cn("in-face shrink-0 overflow-visible", className)}
      style={{ "--face-tone": `var(--in-face-${face.tone})` } as React.CSSProperties}
    >
      <g className="in-face__all">
        <g className="in-face__body">
          <Body shape={face.shape} />
        </g>
        <g className="in-face__gaze">
          <g className="in-face__lids">
            {spec.eyes.map(([cx, cy], i) => (
              <rect key={i} className="in-face__eye" x={cx - w / 2} y={cy - h / 2} width={w} height={h} rx={r} />
            ))}
          </g>
        </g>
      </g>
    </svg>
  );
}

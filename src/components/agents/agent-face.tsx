/**
 * An agent's face: its identity and its status bar in one drawing.
 *
 * Grok Bot's insight, taken whole (docs/design/AGENTS.md §4): the face is
 * how a roster is read peripherally, and the eyes are how it says what the
 * agent is doing — so there is no spinner beside it. Muse's, taken in part: a
 * prop says what KIND of work (the tiny laptop while a task runs).
 *
 * Every number is from the table in AGENTS.md §4.2b, which the Swift face
 * (`JunoAgentFace.swift`) draws from too. Nothing is traced from a picture.
 *
 * Motion obeys ICONS_AND_MOTION.md §2.2: only transform and opacity move, a
 * state change cross-fades on the fast rung, loops exist only for live states
 * (working, waiting, thinking), `idle` never loops and blinks only under the
 * pointer, and reduced motion stops every loop while the eyes' SHAPE still
 * carries the state. The keyframes are the `.agent-face` block in
 * globals.css. No hooks: safe to render on the server.
 */

import * as React from "react";
import type { AgentAvatar, AgentShape, AgentEyes } from "@/lib/agents/avatar";
import { AGENT_STATE_LABEL, type AgentState } from "@/lib/agents/domain";
import { cn } from "@/lib/utils";

export type AgentFaceSize = "xs" | "sm" | "md" | "lg" | "xl";

const PX: Record<AgentFaceSize, number> = { xs: 20, sm: 28, md: 48, lg: 96, xl: 160 };

interface ShapeSpec {
  eyes: readonly [[number, number], [number, number]];
  scale: number;
}

const SHAPES: Record<AgentShape, ShapeSpec> = {
  orb: { eyes: [[24, 31], [40, 31]], scale: 1 },
  pebble: { eyes: [[24, 32], [40, 32]], scale: 1 },
  capsule: { eyes: [[26, 29], [38, 29]], scale: 0.9 },
  petal: { eyes: [[26, 34], [42, 34]], scale: 1 },
  bloom: { eyes: [[25, 32], [39, 32]], scale: 0.95 },
  spark: { eyes: [[27, 33], [37, 33]], scale: 0.75 },
};

const EYES: Record<AgentEyes, { w: number; h: number; r: number }> = {
  soft: { w: 7, h: 9, r: 2.5 },
  round: { w: 6.5, h: 6.5, r: 3.25 },
  tall: { w: 5, h: 11, r: 2.5 },
  wide: { w: 10, h: 5.5, r: 2.75 },
};

function Body({ shape }: { shape: AgentShape }) {
  switch (shape) {
    case "orb":
      return <circle cx={32} cy={33} r={26} />;
    case "pebble":
      return <rect x={6} y={9} width={52} height={48} rx={20} />;
    case "capsule":
      return <rect x={12} y={5} width={40} height={56} rx={20} />;
    case "petal":
      return <path d="M8 9 H34 C48 9 58 21 58 35 C58 49 47 59 33 59 C19 59 8 48 8 34 Z" />;
    case "bloom":
      return (
        <>
          <circle cx={22} cy={23} r={15} />
          <circle cx={42} cy={23} r={15} />
          <circle cx={22} cy={43} r={15} />
          <circle cx={42} cy={43} r={15} />
          <rect x={22} y={23} width={20} height={20} />
        </>
      );
    case "spark":
      return <path d="M32 5 C36 22 42 28 59 33 C42 38 36 44 32 61 C28 44 22 38 5 33 C22 28 28 22 32 5 Z" />;
  }
}

/** The open ring with its ball terminal: 70° open at the upper right, ball at the gap's leading end. */
function ringPath(): { arc: string; ball: [number, number] } {
  const cx = 51;
  const cy = 12;
  const r = 5.5;
  const at = (deg: number): [number, number] => {
    const t = (deg * Math.PI) / 180;
    return [Math.round((cx + r * Math.cos(t)) * 100) / 100, Math.round((cy + r * Math.sin(t)) * 100) / 100];
  };
  // Gap from -80° to -10° (clockwise from three o'clock, y down).
  const start = at(-10);
  const end = at(-80);
  return { arc: `M${start[0]} ${start[1]} A${r} ${r} 0 1 1 ${end[0]} ${end[1]}`, ball: at(-45) };
}
const RING = ringPath();

function Mark({ mark, eyes }: { mark: AgentAvatar["mark"]; eyes: ShapeSpec["eyes"] }) {
  switch (mark) {
    case "none":
      return null;
    case "ring":
      return (
        <g className="agent-face__mark">
          <path d={RING.arc} fill="none" strokeWidth={2.2} strokeLinecap="round" />
          <circle cx={RING.ball[0]} cy={RING.ball[1]} r={1.8} stroke="none" />
        </g>
      );
    case "spark":
      return (
        <path
          className="agent-face__mark"
          stroke="none"
          d="M51 5 Q52.4 10.6 58 12 Q52.4 13.4 51 19 Q49.6 13.4 44 12 Q49.6 10.6 51 5 Z"
        />
      );
    case "leaf":
      return <path className="agent-face__mark" stroke="none" d="M44 18 C44 11 49 6 57 6 C57 13 52 18 44 18 Z" />;
    case "antenna":
      return (
        <g className="agent-face__mark">
          <path d="M32 8 L32 2.5" fill="none" strokeWidth={2} strokeLinecap="round" />
          <circle cx={32} cy={2.5} r={2.2} stroke="none" />
        </g>
      );
    case "visor": {
      const [[lx, y], [rx]] = eyes;
      return (
        <rect
          className="agent-face__visor"
          x={lx - 7}
          y={y - 6}
          width={rx - lx + 14}
          height={12}
          rx={6}
          stroke="none"
        />
      );
    }
  }
}

export interface AgentFaceProps {
  avatar: AgentAvatar;
  state?: AgentState;
  size?: AgentFaceSize | number;
  /** The agent's name, for the accessible label. Omit when the name is printed beside the face. */
  name?: string;
  /**
   * The state the label names, when it is not the one drawn. The hire arrival
   * draws `done` then `idle` as a greeting (AGENTS.md §5.1); a screen reader is
   * told the agent's real state, not the choreography.
   */
  labelState?: AgentState;
  className?: string;
}

export function AgentFace({ avatar, state = "idle", size = "md", name, labelState, className }: AgentFaceProps) {
  const px = typeof size === "number" ? size : PX[size];
  const spec = SHAPES[avatar.shape];
  const cut = EYES[avatar.eyes];
  const w = cut.w * spec.scale;
  const h = cut.h * spec.scale;
  const r = cut.r * spec.scale;
  // The mark and the prop are dropped below 28px; the eyes never are.
  const detailed = px >= 28;
  const label = name ? `${name}, ${AGENT_STATE_LABEL[labelState ?? state].toLowerCase()}` : undefined;

  return (
    <svg
      viewBox="0 0 64 64"
      width={px}
      height={px}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      data-state={state}
      className={cn("agent-face shrink-0 overflow-visible", className)}
      style={{ "--face-tone": `var(--agent-${avatar.tone})` } as React.CSSProperties}
    >
      <g className="agent-face__all">
        <g className="agent-face__body">
          <Body shape={avatar.shape} />
        </g>
        {detailed && avatar.mark === "visor" ? <Mark mark="visor" eyes={spec.eyes} /> : null}
        {/* Gaze: the eyes (and the happy arcs) follow the pointer through two
            custom properties set by AgentPresence. A wrapper, so the state
            animations on the eyes themselves are untouched. */}
        <g className="agent-face__gaze">
        <g className="agent-face__eyes">
          {spec.eyes.map(([cx, cy], i) => (
            <rect
              key={i}
              className="agent-face__eye"
              x={cx - w / 2}
              y={cy - h / 2}
              width={w}
              height={h}
              rx={r}
              style={{ "--eye-h": h } as React.CSSProperties}
            />
          ))}
        </g>
        <g className="agent-face__happy" fill="none">
          {spec.eyes.map(([cx, cy], i) => (
            <path
              key={i}
              d={`M${cx - 4} ${cy + 1.5} Q${cx} ${cy - 3.5} ${cx + 4} ${cy + 1.5}`}
              strokeWidth={2.4}
              strokeLinecap="round"
            />
          ))}
        </g>
        </g>
        {detailed && avatar.mark !== "visor" ? <Mark mark={avatar.mark} eyes={spec.eyes} /> : null}
        {detailed ? (
          <g className="agent-face__dots">
            <circle cx={50} cy={12} r={1.6} />
            <circle cx={55} cy={12} r={1.6} />
            <circle cx={60} cy={12} r={1.6} />
          </g>
        ) : null}
        {px >= 40 ? (
          <g className="agent-face__prop" fill="none">
            <rect x={46} y={45} width={12} height={8} rx={1.5} strokeWidth={1.6} />
            <path d="M43.5 55.5 H60.5" strokeWidth={2} strokeLinecap="round" />
          </g>
        ) : null}
      </g>
    </svg>
  );
}

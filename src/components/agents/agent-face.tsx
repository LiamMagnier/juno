"use client";

/**
 * An agent's face: its identity and its status bar in one drawing.
 *
 * Grok Bot's insight, taken whole (docs/design/AGENTS.md §4): the face is
 * how a roster is read peripherally, and the eyes are how it says what the
 * agent is doing, so there is no spinner beside it.
 *
 * Every number is from the table in AGENTS.md §4.2b, which the Swift face
 * (`JunoAgentFace.swift`) draws from too. Nothing is traced from a picture.
 *
 * Three layers of motion (docs/design/agents-rework/MOTION.md):
 *  - the rig (face-rig.ts) makes every face present: it blinks, glances
 *    around, looks at the pointer, and notices when you hover it;
 *  - the state is a behaviour, drawn in agent-face.css: working reads and
 *    bobs, thinking looks up with rising thought dots, waiting looks at you
 *    and lifts, done squints happily and hops once;
 *  - a change of state is a visible reaction (`data-react`), not a cut.
 * Reduced motion stops all of it; the eyes' SHAPE still carries the state.
 */

import * as React from "react";
import type { AgentAvatar, AgentShape, AgentEyes } from "@/lib/agents/avatar";
import { AGENT_STATE_LABEL, type AgentState } from "@/lib/agents/domain";
import { cn } from "@/lib/utils";
import { attachFaceRig, type FaceRigHandle } from "./face-rig";

export type AgentFaceSize = "xs" | "sm" | "md" | "lg" | "xl";

const PX: Record<AgentFaceSize, number> = { xs: 20, sm: 28, md: 48, lg: 96, xl: 160 };

interface ShapeSpec {
  eyes: readonly [[number, number], [number, number]];
  scale: number;
}

const SHAPES: Record<AgentShape, ShapeSpec> = {
  tile: { eyes: [[24, 32], [40, 32]], scale: 0.9 },
  halo: { eyes: [[25, 33], [39, 33]], scale: 0.85 },
  prism: { eyes: [[25, 32], [39, 32]], scale: 0.85 },
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
    case "tile":
      return <path d="M21 6 H43 Q58 6 58 21 V43 Q58 58 43 58 H21 Q6 58 6 43 V21 Q6 6 21 6 Z" />;
    case "halo":
      return <path fillRule="evenodd" d="M32 4 A28 28 0 1 1 31.99 4 Z M32 9 A5 5 0 1 0 32.01 9 Z" />;
    case "prism":
      return <path d="M27 5 Q32 2 37 5 L55 16 Q60 19 60 25 V40 Q60 46 55 49 L37 60 Q32 63 27 60 L9 49 Q4 46 4 40 V25 Q4 19 9 16 Z" />;
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
  /**
   * On the rig (face-rig.ts): blinks, glances, and looks at the pointer. On by
   * default; off for faces that are pictures of a choice (the face studio's
   * swatches), where twenty blinking faces would be noise.
   */
  live?: boolean;
  className?: string;
}

/** The body's light: a soft top-left key, the tone itself, a deeper rim. */
function Shading({ id }: { id: string }) {
  return (
    <defs>
      <radialGradient id={id} cx="0.34" cy="0.26" r="0.86">
        <stop offset="0" className="agent-face__lit" />
        <stop offset="0.52" className="agent-face__tone" />
        <stop offset="1" className="agent-face__rim" />
      </radialGradient>
    </defs>
  );
}

export function AgentFace({ avatar, state = "idle", size = "md", name, labelState, live = false, className }: AgentFaceProps) {
  const px = typeof size === "number" ? size : PX[size];
  const spec = SHAPES[avatar.shape];
  const cut = EYES[avatar.eyes];
  const w = cut.w * spec.scale;
  const h = cut.h * spec.scale;
  const r = cut.r * spec.scale;
  // The mark and the thinking/working details are dropped below 28px; the
  // eyes never are. Light, catchlights and the ground shadow need room to read.
  const detailed = px >= 28;
  const rich = px >= 40;
  const label = name ? `${name}, ${AGENT_STATE_LABEL[labelState ?? state].toLowerCase()}` : undefined;
  const gradientId = `agent-face-${React.useId().replace(/:/g, "")}`;
  const ref = React.useRef<SVGSVGElement | null>(null);
  const rig = React.useRef<FaceRigHandle | null>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (!el || !live) return;
    const handle = attachFaceRig(el, state, px);
    rig.current = handle;
    return () => {
      handle.release();
      rig.current = null;
    };
    // The rig is attached once per element; state reaches it below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, px]);

  // A change of state is a small visible reaction (a settle), not a cut.
  const previous = React.useRef(state);
  React.useEffect(() => {
    rig.current?.setState(state);
    const el = ref.current;
    if (!el || previous.current === state) return;
    previous.current = state;
    el.removeAttribute("data-react");
    // Restart the one-shot even when two changes land in a row.
    void el.getBoundingClientRect();
    el.setAttribute("data-react", "");
    const timer = window.setTimeout(() => el.removeAttribute("data-react"), 700);
    return () => window.clearTimeout(timer);
  }, [state]);

  return (
    <svg
      ref={ref}
      viewBox="0 0 64 64"
      width={px}
      height={px}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      data-state={state}
      data-rich={rich ? "" : undefined}
      className={cn("agent-face shrink-0 overflow-visible", className)}
      style={{ "--face-tone": `var(--agent-${avatar.tone})` } as React.CSSProperties}
    >
      {rich ? <Shading id={gradientId} /> : null}
      {rich ? <ellipse className="agent-face__ground" cx={32} cy={62.5} rx={16} ry={2.4} /> : null}
      <g className="agent-face__rig">
        <g className="agent-face__all">
          <g className="agent-face__body" style={rich ? { fill: `url(#${gradientId})` } : undefined}>
            <Body shape={avatar.shape} />
          </g>
          {detailed && avatar.mark === "visor" ? <Mark mark="visor" eyes={spec.eyes} /> : null}
          <g className="agent-face__gaze">
            <g className="agent-face__eyes">
              <g className="agent-face__lids">
                {spec.eyes.map(([cx, cy], i) => (
                  <g key={i} className="agent-face__eye" style={{ "--eye-h": h } as React.CSSProperties}>
                    <rect className="agent-face__pupil" x={cx - w / 2} y={cy - h / 2} width={w} height={h} rx={r} />
                    {rich ? (
                      <circle
                        className="agent-face__glint"
                        cx={cx - w / 2 + Math.min(w, h) * 0.34}
                        cy={cy - h / 2 + Math.min(w, h) * 0.34}
                        r={Math.max(0.8, Math.min(w, h) * 0.17)}
                      />
                    ) : null}
                  </g>
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
          </g>
          {detailed && avatar.mark !== "visor" ? <Mark mark={avatar.mark} eyes={spec.eyes} /> : null}
          {detailed ? (
            <g className="agent-face__thought">
              <circle cx={49} cy={13} r={1.5} />
              <circle cx={54} cy={8.5} r={2} />
              <circle cx={60} cy={3.5} r={2.6} />
            </g>
          ) : null}
          {detailed ? (
            <g className="agent-face__workbars">
              {[25, 30.5, 36].map((x) => (
                <rect key={x} x={x} y={45} width={3} height={3} rx={1.5} />
              ))}
            </g>
          ) : null}
        </g>
      </g>
    </svg>
  );
}

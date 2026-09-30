"use client";

import * as React from "react";
import type { AgentAvatar, AgentEyes, AgentShape, AgentTone } from "@/lib/agents/avatar";
import { cn } from "@/lib/utils";
import { PRESENCE_LABEL, type Presence } from "./fixtures";

/*
 * A crew member's face, drawn the Porcelain way: the same four-word avatar
 * data as the product face (shape, tone, eyes, mark), set flat in a glaze
 * tone, with the eyes as the state indicator.
 *
 * Motion is for events only (the craft rules forbid idle loops):
 *   - blink: once when the face appears, again when it is hovered or focused
 *   - a change of state: a 420ms settle, then the new pose holds
 *   - waiting: two small "over here" lifts when the wait begins, then still
 *   - working: the eyes read across once and settle low
 * Reduced motion keeps every pose (the eye shape still says the state) and
 * drops every movement. The state is always also words beside the face.
 */

const SHAPES: Partial<Record<AgentShape, { eyes: readonly [[number, number], [number, number]]; scale: number }>> = {
  tile: { eyes: [[24, 32], [40, 32]], scale: 0.9 },
  orb: { eyes: [[24, 31], [40, 31]], scale: 1 },
  pebble: { eyes: [[24, 32], [40, 32]], scale: 1 },
  capsule: { eyes: [[26, 29], [38, 29]], scale: 0.9 },
  petal: { eyes: [[26, 34], [42, 34]], scale: 1 },
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
    case "capsule":
      return <rect x={12} y={5} width={40} height={56} rx={20} />;
    case "petal":
      return <path d="M8 9 H34 C48 9 58 21 58 35 C58 49 47 59 33 59 C19 59 8 48 8 34 Z" />;
    case "pebble":
      return <rect x={6} y={9} width={52} height={48} rx={20} />;
    default:
      return <circle cx={32} cy={33} r={26} />;
  }
}

/** Glaze tones: the product's six hues, pulled down to porcelain chroma. */
export const GLAZE: Record<AgentTone, string> = {
  teal: "var(--pc-glaze-teal)",
  violet: "var(--pc-glaze-violet)",
  juniper: "var(--pc-glaze-juniper)",
  coral: "var(--pc-glaze-coral)",
  sage: "var(--pc-glaze-sage)",
  amber: "var(--pc-glaze-amber)",
};

export interface FaceProps {
  avatar: AgentAvatar;
  presence?: Presence;
  size?: number;
  /** Name for the accessible label; omit when the name is printed beside it. */
  name?: string;
  className?: string;
  /** Force a blink now (the motion page drives this). */
  blinkKey?: number;
}

export function Face({ avatar, presence = "available", size = 20, name, className, blinkKey }: FaceProps) {
  const spec = SHAPES[avatar.shape] ?? SHAPES.orb!;
  const cut = EYES[avatar.eyes];
  const w = cut.w * spec.scale;
  const h = cut.h * spec.scale;
  const r = Math.min(cut.r * spec.scale, w / 2, h / 2);
  const ref = React.useRef<SVGSVGElement | null>(null);
  const label = name ? `${name}, ${PRESENCE_LABEL[presence].toLowerCase()}` : undefined;

  const blink = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.removeAttribute("data-blink");
    void el.getBoundingClientRect();
    el.setAttribute("data-blink", "");
  }, []);

  // Blink once when the face appears (a sign of life, then stillness).
  React.useEffect(() => {
    const t = window.setTimeout(blink, 500 + Math.round(Math.random() * 700));
    return () => window.clearTimeout(t);
  }, [blink]);

  React.useEffect(() => {
    if (blinkKey) blink();
  }, [blinkKey, blink]);

  // A change of state is a visible settle, not a cut.
  const previous = React.useRef(presence);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || previous.current === presence) return;
    previous.current = presence;
    el.removeAttribute("data-react");
    void el.getBoundingClientRect();
    el.setAttribute("data-react", "");
    const t = window.setTimeout(() => el.removeAttribute("data-react"), 2600);
    return () => window.clearTimeout(t);
  }, [presence]);

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
      data-small={size < 24 ? "" : undefined}
      className={cn("pc-face", className)}
      style={{ "--face-glaze": GLAZE[avatar.tone] } as React.CSSProperties}
      onPointerEnter={blink}
      onAnimationEnd={(e) => {
        if ((e.target as Element).classList.contains("pc-face__lids")) ref.current?.removeAttribute("data-blink");
      }}
    >
      <g className="pc-face__all">
        <g className="pc-face__body">
          <Body shape={avatar.shape} />
        </g>
        <g className="pc-face__eyes">
          <g className="pc-face__lids">
            {spec.eyes.map(([cx, cy], i) => (
              <rect key={i} className="pc-face__eye" x={cx - w / 2} y={cy - h / 2} width={w} height={h} rx={r} />
            ))}
          </g>
        </g>
      </g>
    </svg>
  );
}

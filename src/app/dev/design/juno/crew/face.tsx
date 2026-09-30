"use client";

/**
 * CrewFace: a crew member's identity and presence in one small drawing.
 *
 * The grammar (chosen in CrewLab, see RATIONALE.md): a lit body in
 * three-quarter view. Three things are the member's own and never change:
 * its colour family, its form (proportions from the seed) and the set of its
 * eyes. Everything that changes is presence, and presence is carried by four
 * quantities only, each a registered CSS custom property so any change is an
 * interruptible transition (face.css):
 *
 *   --jc-yaw, --jc-pitch   where it is looking (eyes are points on a sphere)
 *   --jc-lid               how open the eyes are
 *   --jc-dark              how much of it is in shadow (light is presence)
 *   --jc-lift, --jc-lean   posture
 *
 *   available   three-quarter, looking ahead, lit
 *   thinking    eyes up and away; occasional small saccades while it lasts
 *   working     eyes down on the work, lids lowered, leaning in
 *   waiting     turned to you, fully lit, lifted (one attention gesture, then still)
 *   paused      lids closed, waned to a crescent, settled lower
 *   offline     light out, eyes gone, dimmed
 *
 * State is always also text: the face carries an accessible name only when
 * asked (`label`), because rows print the name and the state beside it.
 */
import * as React from "react";
import { formFromSeed, bodyPath, familyFromSeed, type CrewFamily, type CrewForm } from "./identity";
import { registerFace } from "./rig";
import "./face.css";

export type CrewState = "available" | "thinking" | "working" | "waiting" | "paused" | "offline";

export const CREW_STATE_LABEL: Record<CrewState, string> = {
  available: "Available",
  thinking: "Thinking",
  working: "Working",
  waiting: "Waiting for you",
  paused: "Paused",
  offline: "Offline",
};

export interface CrewMember {
  id: string;
  name: string;
  role?: string;
  /** A seed the identity system derives shape and colour from. */
  seed: string;
  /** The colour family, when the person chose one. Otherwise derived from the seed. */
  family?: CrewFamily;
}

export interface CrewFaceProps {
  member: CrewMember;
  state?: CrewState;
  size?: number;
  className?: string;
  /**
   * Motion on (blink, pointer attention, saccades while thinking, state
   * gestures). Off for faces that are pictures of a choice (a colour swatch
   * grid), where twenty moving faces would be noise. Reduced motion always
   * turns it off.
   */
  live?: boolean;
  /** Play the arrival (a new member being lit for the first time). */
  arrive?: boolean;
  /** Which way the three-quarter view faces at rest. Rows face their text. */
  facing?: "right" | "left" | "front";
  /** Give the face an accessible name ("Mira, waiting for you"). Omit when the name is printed beside it. */
  label?: boolean;
}

/** The pose each state rests in. Numbers are unitless; face.css turns them into geometry. */
export const POSE: Record<CrewState, { yaw: number; pitch: number; lid: number; dark: number; lift: number; lean: number }> = {
  available: { yaw: 0.34, pitch: 0.05, lid: 0, dark: 0.2, lift: 0, lean: 0 },
  thinking: { yaw: 0.12, pitch: -0.78, lid: 0.08, dark: 0.2, lift: 0, lean: -1.2 },
  working: { yaw: 0.46, pitch: 0.72, lid: 0.4, dark: 0.2, lift: 0.4, lean: 2.4 },
  waiting: { yaw: 0, pitch: -0.05, lid: 0, dark: 0, lift: -1.8, lean: 0 },
  paused: { yaw: 0.22, pitch: 0.5, lid: 0.84, dark: 0.7, lift: 1.3, lean: 0.8 },
  offline: { yaw: 0.22, pitch: 0.5, lid: 1, dark: 1, lift: 1.3, lean: 0 },
};

/** Optical compensation: small faces get relatively larger eyes so they stay legible. */
function eyeScaleFor(size: number) {
  if (size <= 16) return 1.3;
  if (size <= 20) return 1.2;
  if (size <= 28) return 1.08;
  return 1;
}

interface Geometry {
  d: string;
  R: number;
  cy: number;
  eyeW: number;
  eyeH: number;
  spread: number;
  lat: number;
  lean: number;
}

const cache = new Map<string, Geometry>();
/** Pure geometry for a seed: memoised because rosters repeat faces. */
export function faceGeometry(seed: string): Geometry {
  const hit = cache.get(seed);
  if (hit) return hit;
  const f = formFromSeed(seed);
  const form: CrewForm = {
    ...f,
    // A head, not a tile: rounder than the lab pebble, still individual.
    nTop: 2.02 + (f.nTop - 2.25) * 0.5,
    nBottom: 2.2 + (f.nBottom - 2.6) * 0.42,
    taper: f.taper * 0.55,
  };
  const cy = 33;
  const g: Geometry = {
    d: bodyPath(form, 32, cy, 44),
    R: (form.rx + form.ry) / 2,
    cy,
    eyeW: f.eyeW * 0.86,
    eyeH: f.eyeH * 1.22,
    spread: 17 + (f.eyeGap - 6.6) * 2.4,
    lat: 1.5 + (f.eyeY + 3.6) * 1.4,
    lean: f.lean,
  };
  cache.set(seed, g);
  return g;
}

export function CrewFace({
  member,
  state = "available",
  size = 20,
  className,
  live = true,
  arrive = false,
  facing = "right",
  label = false,
}: CrewFaceProps) {
  const family = member.family ?? familyFromSeed(member.seed);
  const g = faceGeometry(member.seed);
  const clipId = `jcf${React.useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const ref = React.useRef<SVGSVGElement | null>(null);
  const pose = POSE[state];
  const dir = facing === "left" ? -1 : facing === "front" ? 0 : 1;
  const k = eyeScaleFor(size);
  const ew = g.eyeW * k;
  const eh = g.eyeH * k;

  // The rig: blink, pointer attention, saccades, gestures on change.
  React.useEffect(() => {
    const el = ref.current;
    if (!el || !live) return;
    return registerFace(el, { state, size, arrive });
    // Registration follows the element; state changes are pushed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || !live) return;
    el.dispatchEvent(new CustomEvent("jc-face-state", { detail: state }));
  }, [state, live]);

  const style = {
    width: size,
    height: size,
    "--jc-yaw": pose.yaw * (dir === 0 ? 0.2 : dir),
    "--jc-pitch": pose.pitch,
    "--jc-lid": pose.lid,
    "--jc-dark": pose.dark,
    "--jc-lift": pose.lift,
    "--jc-lean": pose.lean + g.lean,
    "--jc-R": g.R * 0.94,
    "--jc-cy": g.cy,
    "--jc-spread": g.spread,
    "--jc-lat": g.lat,
    "--jc-eh": eh,
  } as React.CSSProperties;

  const name = label ? `${member.name}, ${CREW_STATE_LABEL[state].toLowerCase()}` : undefined;

  return (
    <svg
      ref={ref}
      className={className ? `jc-face ${className}` : "jc-face"}
      viewBox="0 0 64 64"
      data-family={family}
      data-state={state}
      data-arrive={arrive ? "" : undefined}
      data-live={live ? "" : undefined}
      data-small={size <= 20 ? "" : undefined}
      role={name ? "img" : undefined}
      aria-label={name}
      aria-hidden={name ? undefined : true}
      style={style}
      focusable="false"
    >
      <defs>
        <clipPath id={clipId}>
          <path d={g.d} />
        </clipPath>
      </defs>
      <g className="jc-face__posture">
        <path className="jc-face__body" d={g.d} />
        <g clipPath={`url(#${clipId})`}>
          <circle className="jc-face__light" cx={32} cy={g.cy} r={g.R * 1.1} />
        </g>
        <g className="jc-face__eyes">
          {[-1, 1].map((side) => (
            <g key={side} className="jc-face__eye" style={{ "--side": side } as React.CSSProperties}>
              <rect x={-ew / 2} y={-eh} width={ew} height={eh} rx={ew / 2} />
            </g>
          ))}
        </g>
      </g>
    </svg>
  );
}

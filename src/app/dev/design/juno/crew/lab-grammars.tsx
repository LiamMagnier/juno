/**
 * The four shape grammars explored in the crew lab (CrewLab), drawn still.
 * Lab only: the chosen grammar lives in face.tsx with its motion rig. These
 * stay so the decision can be re-read beside its alternatives.
 */
import * as React from "react";
import { bodyPath, formFromSeed, superellipse, prng, hashSeed, type CrewFamily } from "./identity";
import { CrewFace, type CrewState } from "./face";

export type Grammar = "pebble" | "orbit" | "glyph" | "moon" | "cut" | "stone" | "turn" | "final";

export const GRAMMARS: { id: Grammar; name: string; idea: string }[] = [
  { id: "pebble", name: "A · Pebble", idea: "A resting stone, individual in proportion, with eyes cut through it." },
  { id: "orbit", name: "B · Orbit", idea: "A body and its satellite. The satellite is the attention; no face." },
  { id: "glyph", name: "C · Glyph", idea: "A drawn portrait in the icon set's stroke: outline, tint, two strokes." },
  { id: "moon", name: "D · Moon", idea: "A lit sphere whose phase is the state, eyes on the lit side." },
  { id: "cut", name: "E · Cut", idea: "Cut paper: an organic outline unique to the seed, flat colour, calm eyes." },
  { id: "stone", name: "F · Lit stone", idea: "The pebble's individual form with the moon's light: phase is presence." },
  { id: "turn", name: "G · Turn", idea: "A lit sphere in three-quarter view. It turns to you when it needs you; light is presence." },
  { id: "final", name: "H · Lit head (CrewFace)", idea: "G, rebuilt as the live component: rounder, eyes low and close, light as presence." },
];

/**
 * G · Turn: eyes are points on a sphere. Yaw and pitch rotate them and an
 * orthographic projection places them; the far eye foreshortens. Returns the
 * two eye rectangles in drawing units.
 */
export function turnEyes(opts: {
  cx: number;
  cy: number;
  R: number;
  yaw: number;
  pitch: number;
  spread: number;
  lat: number;
  w: number;
  h: number;
}) {
  const { cx, cy, R, yaw, pitch, spread, lat, w, h } = opts;
  const rad = Math.PI / 180;
  return [-1, 1].map((side) => {
    const lon = (side * spread + yaw * 38) * rad;
    const la = (lat + pitch * 22) * rad;
    const x = cx + R * Math.cos(la) * Math.sin(lon);
    const y = cy + R * Math.sin(la);
    const facing = Math.cos(la) * Math.cos(lon);
    const ew = w * Math.max(0.45, Math.pow(Math.max(0, facing), 0.8));
    return { side, x, y, w: ew, h: h * Math.max(0.75, Math.pow(Math.cos(la), 0.5)) };
  });
}

interface Props {
  grammar: Grammar;
  seed: string;
  family: CrewFamily;
  state: CrewState;
  size: number;
}

const uid = 0;
function useUid(prefix: string) {
  const id = React.useId();
  return `${prefix}${id.replace(/[^a-zA-Z0-9]/g, "")}${uid}`;
}

export function LabFace({ grammar, seed, family, state, size }: Props) {
  const mask = useUid("m");
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 64 64",
    className: "jc-lab-face",
    "data-family": family,
    "data-state": state,
    "aria-hidden": true as const,
  };
  if (grammar === "pebble") return <Pebble {...common} seed={seed} state={state} mask={mask} />;
  if (grammar === "orbit") return <Orbit {...common} seed={seed} state={state} mask={mask} />;
  if (grammar === "glyph") return <Glyph {...common} seed={seed} state={state} size={size} />;
  if (grammar === "cut") return <Cut {...common} seed={seed} state={state} />;
  if (grammar === "stone") return <Stone {...common} seed={seed} state={state} mask={mask} />;
  if (grammar === "turn") return <Turn {...common} seed={seed} state={state} mask={mask} />;
  if (grammar === "final") return <CrewFace member={{ id: seed, name: "", seed, family }} state={state} size={size} live={false} />;
  return <Moon {...common} seed={seed} state={state} mask={mask} />;
}

/* G · Turn ------------------------------------------------------------------ */
function Turn({ seed, state, mask, ...svg }: SvgBase & { mask: string }) {
  const f = formFromSeed(seed);
  // Rounder than the pebble: a head, so turning reads.
  const form = { ...f, nTop: 2 + (f.nTop - 2.25) * 0.5, nBottom: 2.2 + (f.nBottom - 2.6) * 0.45, taper: f.taper * 0.6 };
  const d = bodyPath(form);
  const R = (form.rx + form.ry) / 2;
  const pose: Record<CrewState, { yaw: number; pitch: number; phase: number; lift: number; lean: number; lid: number }> = {
    available: { yaw: 0.42, pitch: 0, phase: 0.8, lift: 0, lean: 0, lid: 0 },
    thinking: { yaw: 0.2, pitch: -0.75, phase: 0.8, lift: 0, lean: -1.5, lid: 0 },
    working: { yaw: 0.55, pitch: 0.7, phase: 0.8, lift: 0, lean: 2.5, lid: 0.42 },
    waiting: { yaw: 0, pitch: 0, phase: 1, lift: -1.6, lean: 0, lid: 0 },
    paused: { yaw: 0.3, pitch: 0.45, phase: 0.3, lift: 1.2, lean: 1, lid: 1 },
    offline: { yaw: 0.3, pitch: 0.45, phase: 0, lift: 1.2, lean: 0, lid: 1 },
  };
  const p = pose[state];
  const eyes = turnEyes({ cx: 32, cy: 33, R: R * 0.96, yaw: p.yaw, pitch: p.pitch, spread: 21 + (f.eyeGap - 7.4) * 2, lat: -9 + f.eyeY, w: f.eyeW * 0.78, h: f.eyeH * 1.18 });
  const LR = 40;
  const k = LR * (2 * p.phase - 1);
  const cx = 32;
  const cy = 33;
  const lit =
    p.phase >= 1
      ? null
      : `M${cx} ${cy - LR} A${LR} ${LR} 0 0 0 ${cx} ${cy + LR} A${Math.abs(k)} ${LR} 0 0 ${k > 0 ? 0 : 1} ${cx} ${cy - LR}Z`;
  return (
    <svg {...svg}>
      <defs>
        <clipPath id={mask}>
          <path d={d} />
        </clipPath>
      </defs>
      <g transform={`translate(0 ${p.lift}) rotate(${f.lean + p.lean} 32 56)`}>
        <path d={d} className="jc-lab-shade" />
        {p.phase > 0 ? (
          lit ? (
            <g clipPath={`url(#${mask})`}>
              <path d={lit} className="jc-lab-body" transform="rotate(-28 32 33)" />
            </g>
          ) : (
            <path d={d} className="jc-lab-body" />
          )
        ) : null}
        {state === "offline" ? null : (
          <g className="jc-lab-deep">
            {eyes.map((e) =>
              p.lid >= 1 ? (
                <path
                  key={e.side}
                  className="jc-lab-lid"
                  d={`M${e.x - e.w * 0.75} ${e.y + e.h * 0.18} q${e.w * 0.75} ${e.h * 0.28} ${e.w * 1.5} 0`}
                />
              ) : (
                <rect
                  key={e.side}
                  x={e.x - e.w / 2}
                  y={e.y - e.h / 2 + e.h * p.lid}
                  width={e.w}
                  height={e.h * (1 - p.lid)}
                  rx={Math.min(e.w, e.h * (1 - p.lid)) / 2}
                />
              ),
            )}
          </g>
        )}
      </g>
    </svg>
  );
}

/** Eyes shared by E and F: soft ovals whose lids and gaze carry the state. */
function Eyes({ cx, cy, gap, w, h, state }: { cx: number; cy: number; gap: number; w: number; h: number; state: CrewState }) {
  let gx = 0;
  let gy = 0;
  let eh = h;
  let ew = w;
  if (state === "thinking") {
    gx = -2.4;
    gy = -2.8;
    eh = h * 0.92;
  } else if (state === "working") {
    gy = 2.6;
    eh = h * 0.58;
  } else if (state === "waiting") {
    ew = w * 1.06;
    eh = h * 1.12;
  }
  if (state === "offline") return null;
  return (
    <g className="jc-lab-deep">
      {[-1, 1].map((s) => {
        const x = cx + s * gap + gx;
        if (state === "paused") {
          return <path key={s} d={`M${x - w * 0.7} ${cy + 1.2} q${w * 0.7} ${2.4} ${w * 1.4} 0`} fill="none" className="jc-lab-lid" />;
        }
        const top = state === "working" ? cy + gy + h / 2 - eh : cy + gy - eh / 2;
        return <rect key={s} x={x - ew / 2} y={top} width={ew} height={eh} rx={Math.min(ew, eh) / 2} />;
      })}
    </g>
  );
}

/* E · Cut ------------------------------------------------------------------- */
function cutPath(seed: string, cx: number, cy: number, R: number) {
  const r = prng(hashSeed(`cut:${seed}`));
  const harmonics = [2, 3, 4, 5].map((k) => ({ k, a: (0.018 + r() * 0.03) / (k * 0.55), p: r() * Math.PI * 2 }));
  const sx = 1 + (r() - 0.35) * 0.12;
  const pts: [number, number][] = [];
  const N = 48;
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    let rad = 1;
    for (const h of harmonics) rad += h.a * Math.sin(h.k * t + h.p);
    // A flatter base: pull the lower points up a little.
    const s = Math.sin(t);
    const y = s * rad * (s > 0 ? 0.93 : 1);
    pts.push([cx + Math.cos(t) * rad * R * sx, cy + y * R]);
  }
  let d = "";
  const n = pts.length;
  const p = (i: number) => pts[(i + n) % n];
  const f = (v: number) => Math.round(v * 100) / 100;
  d = `M${f(p(0)[0])} ${f(p(0)[1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = p(i - 1);
    const p1 = p(i);
    const p2 = p(i + 1);
    const p3 = p(i + 2);
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return `${d}Z`;
}

function Cut({ seed, state, ...svg }: SvgBase) {
  const f = formFromSeed(seed);
  const d = cutPath(seed, 32, 33, 25);
  const lift = state === "waiting" ? -1.6 : state === "paused" ? 1.2 : 0;
  return (
    <svg {...svg}>
      <g transform={`translate(0 ${lift})`}>
        <path d={d} className="jc-lab-body" />
        <Eyes cx={32} cy={32 + f.eyeY * 0.6} gap={f.eyeGap} w={f.eyeW * 0.92} h={f.eyeH * 0.92} state={state} />
      </g>
    </svg>
  );
}

/* F · Lit stone ------------------------------------------------------------- */
function Stone({ seed, state, mask, ...svg }: SvgBase & { mask: string }) {
  const f = formFromSeed(seed);
  const d = bodyPath(f);
  const phase: Record<CrewState, number> = {
    available: 0.8,
    thinking: 0.8,
    working: 0.8,
    waiting: 1,
    paused: 0.3,
    offline: 0,
  };
  const p = phase[state];
  const R = 34;
  const k = R * (2 * p - 1);
  const cx = 32;
  const cy = 33;
  // The shade: the part of the body outside a lit disc, drawn with a clip.
  const lit =
    p >= 1
      ? ""
      : `M${cx} ${cy - R} A${R} ${R} 0 0 0 ${cx} ${cy + R} A${Math.abs(k)} ${R} 0 0 ${k > 0 ? 0 : 1} ${cx} ${cy - R}Z`;
  const lift = state === "waiting" ? -1.6 : state === "paused" ? 1 : 0;
  return (
    <svg {...svg}>
      <defs>
        <clipPath id={mask}>
          <path d={d} />
        </clipPath>
      </defs>
      <g transform={`translate(0 ${lift}) rotate(${f.lean} 32 44)`}>
        <path d={d} className={p === 0 ? "jc-lab-shade" : "jc-lab-shade"} />
        {lit ? (
          <g clipPath={`url(#${mask})`}>
            <g transform="rotate(-24 32 33)">
              <path d={lit} className="jc-lab-body" />
            </g>
          </g>
        ) : p > 0 ? (
          <path d={d} className="jc-lab-body" />
        ) : null}
        <Eyes cx={32} cy={33 + f.eyeY} gap={f.eyeGap} w={f.eyeW} h={f.eyeH} state={state} />
      </g>
    </svg>
  );
}

type SvgBase = React.SVGProps<SVGSVGElement> & { seed: string; state: CrewState };

/* A · Pebble ---------------------------------------------------------------- */
function Pebble({ seed, state, mask, ...svg }: SvgBase & { mask: string }) {
  const f = formFromSeed(seed);
  const d = bodyPath(f);
  const cx = 32;
  const cy = 33 + f.eyeY;
  let gx = 0;
  let gy = 0;
  let w = f.eyeW;
  let h = f.eyeH;
  let lift = 0;
  let lean = f.lean;
  let closed = false;
  if (state === "thinking") {
    gx = 2.2;
    gy = -2.6;
    h *= 0.9;
  } else if (state === "working") {
    gy = 2.6;
    h *= 0.62;
    lean += 2;
  } else if (state === "waiting") {
    w *= 1.08;
    h *= 1.1;
    lift = -1.6;
    lean = 0;
  } else if (state === "paused" || state === "offline") {
    closed = true;
    lift = 1;
  }
  const eyes = [-1, 1].map((side) => {
    const ex = cx + side * f.eyeGap + gx;
    if (closed) {
      return <rect key={side} x={ex - w * 0.62} y={cy + 2.2 - 0.95} width={w * 1.24} height={1.9} rx={0.95} />;
    }
    // Working: the upper lid comes down, so the eye keeps its base line.
    const top = state === "working" ? cy + gy + f.eyeH / 2 - h : cy + gy - h / 2;
    return <rect key={side} x={ex - w / 2} y={top} width={w} height={h} rx={Math.min(w, h) / 2} />;
  });
  return (
    <svg {...svg}>
      <defs>
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          <rect width="64" height="64" fill="#fff" />
          <g fill="#000">{eyes}</g>
        </mask>
      </defs>
      <g transform={`translate(0 ${lift}) rotate(${lean} 32 44)`}>
        <path d={d} className="jc-lab-body" mask={`url(#${mask})`} />
      </g>
    </svg>
  );
}

/* B · Orbit ----------------------------------------------------------------- */
function Orbit({ seed, state, mask, ...svg }: SvgBase & { mask: string }) {
  const r = prng(hashSeed(`orbit:${seed}`));
  const R = 20 + r() * 2.5;
  const home = -30 - r() * 30;
  const sat = 5.6 + r() * 1.4;
  const cx = 30;
  const cy = 35;
  let angle = home;
  let orbit = R - 1;
  let sr = sat;
  let docked = false;
  if (state === "thinking") angle = home - 42;
  if (state === "working") {
    angle = 135;
    orbit = R - sat - 3.5;
    sr = sat * 0.8;
    docked = true;
  }
  if (state === "waiting") {
    angle = -90;
    orbit = R + 3;
    sr = sat * 1.2;
  }
  if (state === "paused") angle = 90;
  const t = (angle * Math.PI) / 180;
  const sx = cx + Math.cos(t) * orbit;
  const sy = cy + Math.sin(t) * orbit;
  const offline = state === "offline";
  return (
    <svg {...svg}>
      <defs>
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          <rect width="64" height="64" fill="#fff" />
          {!docked ? <circle cx={sx} cy={sy} r={sr + 2.2} fill="#000" /> : null}
        </mask>
      </defs>
      <circle cx={cx} cy={cy} r={R} className={offline ? "jc-lab-outline" : "jc-lab-body"} mask={`url(#${mask})`} />
      {state === "paused" ? (
        <path d={`M${sx - sr} ${sy} A${sr} ${sr} 0 0 0 ${sx + sr} ${sy}`} className="jc-lab-deep" />
      ) : (
        <circle cx={sx} cy={sy} r={sr} className={offline ? "jc-lab-outline" : "jc-lab-deep"} />
      )}
    </svg>
  );
}

/* C · Glyph ----------------------------------------------------------------- */
function Glyph({ seed, state, size, ...svg }: SvgBase & { size: number }) {
  const f = formFromSeed(seed);
  const d = superellipse(32, 33, f.rx - 1.5, f.ry - 1.5, 2.6 + (f.nBottom - 2.6) * 0.5);
  // Keep the stroke optically near the icon set's 1.5/24 at every size.
  const sw = Math.max(3.2, Math.min(5.2, (1.5 * 64) / size));
  const cy = 33 + f.eyeY;
  const gap = f.eyeGap;
  let eyes: React.ReactNode;
  const line = (x1: number, y1: number, x2: number, y2: number, k: number) => (
    <line key={k} x1={x1} y1={y1} x2={x2} y2={y2} />
  );
  if (state === "paused" || state === "offline") {
    eyes = [-1, 1].map((s) => (
      <path key={s} d={`M${32 + s * gap - 3.2} ${cy + 1} q3.2 2.8 6.4 0`} fill="none" />
    ));
  } else if (state === "thinking") {
    eyes = [-1, 1].map((s) => line(32 + s * gap + 2, cy - 4.5, 32 + s * gap + 2, cy - 0.5, s));
  } else if (state === "working") {
    eyes = [-1, 1].map((s) => line(32 + s * gap - 2.2, cy + 2.5, 32 + s * gap + 2.2, cy + 2.5, s));
  } else if (state === "waiting") {
    eyes = [-1, 1].map((s) => line(32 + s * gap, cy - 4.2, 32 + s * gap, cy + 3.2, s));
  } else {
    eyes = [-1, 1].map((s) => line(32 + s * gap, cy - 2.6, 32 + s * gap, cy + 2.2, s));
  }
  return (
    <svg {...svg}>
      <path d={d} className={state === "offline" ? "jc-lab-glyph-off" : "jc-lab-glyph"} strokeWidth={sw} />
      <g className="jc-lab-glyph-eyes" strokeWidth={sw} strokeLinecap="round">
        {eyes}
      </g>
    </svg>
  );
}

/* D · Moon ------------------------------------------------------------------ */
function Moon({ seed, state, mask, ...svg }: SvgBase & { mask: string }) {
  const r = prng(hashSeed(`moon:${seed}`));
  const R = 25.5;
  const cx = 32;
  const cy = 33;
  // Phase: 1 = full, 0 = new. The terminator is an ellipse of half-width |k|.
  const phase: Record<CrewState, number> = {
    available: 0.82,
    thinking: 0.7,
    working: 0.9,
    waiting: 1,
    paused: 0.28,
    offline: 0,
  };
  const p = phase[state];
  const tilt = -30 + r() * 20;
  // Shade is the unlit part, on the right, swept by the terminator.
  const k = R * (2 * p - 1);
  const shade =
    p >= 1
      ? ""
      : `M${cx} ${cy - R} A${R} ${R} 0 0 1 ${cx} ${cy + R} A${Math.abs(k)} ${R} 0 0 ${k > 0 ? 0 : 1} ${cx} ${cy - R}Z`;
  const turn = state === "thinking" ? -5 : state === "working" ? 0 : 0;
  const drop = state === "working" ? 4 : state === "thinking" ? -4 : 0;
  const gap = 7.2;
  const eyes =
    state === "offline"
      ? null
      : [-1, 1].map((s) => {
          const x = cx - 4 + s * gap + turn;
          const y = cy - 1 + drop;
          // Foreshortening: the eye on the far side of a turn narrows.
          const w = 5 * (turn !== 0 && Math.sign(turn) !== s ? 0.72 : 1);
          if (state === "paused") return <rect key={s} x={x - 3} y={y + 1.5} width={6} height={1.9} rx={0.95} />;
          const h = state === "waiting" ? 8.4 : state === "working" ? 4.4 : 7.2;
          return <rect key={s} x={x - w / 2} y={y - h / 2} width={w} height={h} rx={Math.min(w, h) / 2} />;
        });
  return (
    <svg {...svg}>
      <g transform={`rotate(${tilt} ${cx} ${cy})`}>
        <circle cx={cx} cy={cy} r={R} className={state === "offline" ? "jc-lab-moon-off" : "jc-lab-body"} />
        {shade ? <path d={shade} className="jc-lab-shade" /> : null}
      </g>
      <g className="jc-lab-deep">{eyes}</g>
    </svg>
  );
}

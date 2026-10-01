"use client";

import * as React from "react";
import { useClock, useLevel, useTick } from "./clock";
import { type Talker } from "./signal";

/*
 * THE STRING: Juno's voice signature.
 *
 * One hairline, strung across the composer's voice row between the add
 * button and the controls, in the same 1.5 px the composer's own edge and the
 * icons are drawn with. It is an instrument string, not an effect: it is
 * fixed at both ends (nodes), it only moves when sound moves through it, and
 * when nobody speaks it is a straight, still line. Every state is a different
 * FORM of the one line, a different TONE, and a different MOTION, and also a
 * sentence for assistive technology (the voice row's live region).
 *
 *   connecting    a dashed grey line drawn out of the disc you pressed (560 ms), its dashes drifting toward it
 *   listening     ember (you); still when you are silent, waves travelling left to right (toward Juno) when you speak
 *   thinking      the line rests; one crest carries your words across, ember at its tail, ultramarine at its head (1.5 s)
 *   answering     ultramarine (Juno); waves travelling right to left, out of the disc toward you
 *   muted         grey and still (the mute control says why)
 *   interrupted   Juno's waves die within 200 ms while ember takes the line back from the left (320 ms)
 *   approval      listening, still: the decision is on screen, never spoken
 *   reconnecting  dashed and drifting again
 *   error         the string is broken: two grey halves with a gap, still
 *   ended         the line draws back into the disc (360 ms), and the row becomes the composer again
 *
 * Amplitude follows the level, enveloped so the ends never move (sin^1.5 of
 * the position), capped at ±10 px on desktop and ±7 px on a phone so the row
 * never looks like a meter. Two travelling components, a long one and a
 * short one at 30%, give a voice's texture without noise.
 *
 * Reduced motion (§1.7): nothing travels. Speaking draws a static bow whose
 * height is the level, read four times a second without easing; thinking is
 * the still line in the ember-to-ultramarine blend; connecting is a still
 * dashed line. Tone and form still carry every state.
 */

export type StringPhase = "connecting" | "listening" | "thinking" | "answering" | "muted" | "interrupted" | "approval" | "reconnecting" | "error" | "ended";

/** Which tone the line takes at rest in a phase (the gradient phases override it per frame). */
const TONE: Record<StringPhase, "you" | "juno" | "quiet" | "mix"> = {
  connecting: "quiet",
  listening: "you",
  thinking: "mix",
  answering: "juno",
  muted: "quiet",
  interrupted: "mix",
  approval: "you",
  reconnecting: "quiet",
  error: "quiet",
  ended: "quiet",
};

const N = 120;
const DRAW_IN = 560;
const DRAW_OUT = 360;
const CREST_PERIOD = 1500;
const CREST_TRAVEL = 1150;
const CUT_DECAY = 90;
const CUT_FRONT = 320;

const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
const easeIn = (x: number) => x * x * x;
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function pathOf(pts: [number, number][]): string {
  let d = "";
  for (let i = 0; i < pts.length; i++) d += `${i ? "L" : "M"}${pts[i][0].toFixed(2)} ${pts[i][1].toFixed(2)}`;
  return d;
}

export interface VoiceStringProps {
  phase: StringPhase;
  /** Scene time at which this phase began (draw-in, the cut, the crest's start). */
  since?: number;
  /** Who "answering" is: Juno, or a crew member in their own thread (the line takes their thread colour). */
  answerer?: Talker;
  className?: string;
  /** Lab use: a fixed width instead of measuring. */
  width?: number;
  height?: number;
}

export function VoiceString({ phase, since = 0, answerer = "juno", className, width: fixedW, height = 34 }: VoiceStringProps) {
  const clock = useClock();
  const level = useLevel();
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const pathRef = React.useRef<SVGPathElement | null>(null);
  const stops = React.useRef<(SVGStopElement | null)[]>([]);
  const gradId = React.useId().replace(/[^a-zA-Z0-9]/g, "");
  const [w, setW] = React.useState(fixedW ?? 0);
  const tone = TONE[phase];

  React.useLayoutEffect(() => {
    if (fixedW) return;
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.round(el.getBoundingClientRect().width)));
    ro.observe(el);
    setW(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, [fixedW]);

  useTick(
    (t) => {
      const path = pathRef.current;
      if (!path || w <= 0) return;
      const draw = frame(phase, t, since, w, height, clock.reduced, answerer, level);
      path.setAttribute("d", draw.d);
      path.style.opacity = String(draw.opacity);
      path.setAttribute("stroke-dasharray", draw.dash ?? "none");
      path.setAttribute("stroke-dashoffset", String(draw.dashOffset ?? 0));
      path.setAttribute("stroke", draw.gradient ? `url(#${gradId})` : "currentColor");
      if (draw.gradient) draw.gradient.forEach((g, i) => {
        const s = stops.current[i];
        if (!s) return;
        s.setAttribute("offset", String(clamp01(g.at)));
        s.style.stopColor = g.color;
      });
    },
    [phase, since, w, height, answerer, level],
  );

  return (
    <svg
      ref={svgRef}
      className={["jv-string", className].filter(Boolean).join(" ")}
      data-tone={tone}
      data-phase={phase}
      data-answerer={answerer}
      width={fixedW}
      height={height}
      viewBox={`0 0 ${Math.max(1, w)} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradId} gradientUnits="userSpaceOnUse" x1={0} y1={0} x2={Math.max(1, w)} y2={0}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <stop
              key={i}
              ref={(el) => {
                stops.current[i] = el;
              }}
              offset={i / 5}
            />
          ))}
        </linearGradient>
      </defs>
      <path ref={pathRef} fill="none" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* —————————————————————————— One frame of the string —————————————————————————— */

type Frame = {
  d: string;
  opacity: number;
  dash?: string;
  dashOffset?: number;
  gradient?: { at: number; color: string }[];
};

const YOU = "var(--vs-you)";
const ANSWER = "var(--vs-answer)";
/** The resting line under the thinking crest: a hairline, lighter than muted grey, so the crest is the only thing that reads. */
const REST = "var(--line-3)";
const mix = (p: number) => `color-mix(in oklab, ${YOU} ${Math.round((1 - p) * 100)}%, ${ANSWER})`;

function frame(phase: StringPhase, t: number, since: number, W: number, H: number, reduced: boolean, answerer: Talker, level: (t: number, who: Talker) => number): Frame {
  const pad = 2;
  const L = Math.max(1, W - pad * 2);
  const y0 = H / 2;
  const maxA = W < 260 ? 7 : 10;
  const s = Math.max(0, t - since);
  const flat = (from = 0, to = 1) => pathOf([
    [pad + L * from, y0],
    [pad + L * to, y0],
  ]);

  // A travelling voice through a string fixed at both ends.
  const wave = (amp: number, dir: 1 | -1, tt: number) => {
    const k1 = Math.max(1.2, L / 250);
    const k2 = k1 * 2.6;
    const pts: [number, number][] = [];
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const env = Math.pow(Math.sin(Math.PI * u), 1.5);
      const y = reduced
        ? -amp * 0.85 * Math.sin(Math.PI * u)
        : amp * env * (0.7 * Math.sin(2 * Math.PI * (u * k1 - dir * (tt / 1000) * 0.95)) + 0.3 * Math.sin(2 * Math.PI * (u * k2 - dir * (tt / 1000) * 1.8) + 1.3));
      pts.push([pad + u * L, y0 + y]);
    }
    return pts;
  };
  const presenceOf = (lv: number) => 0.42 + 0.58 * clamp01(lv * 1.8);

  switch (phase) {
    case "listening":
    case "approval": {
      const lv = level(t, "you");
      return { d: pathOf(wave(maxA * lv, 1, t)), opacity: presenceOf(lv) };
    }
    case "answering": {
      const lv = level(t, answerer);
      return { d: pathOf(wave(maxA * lv, -1, t)), opacity: presenceOf(lv) };
    }
    case "muted":
      return { d: flat(), opacity: 1 };
    case "thinking": {
      if (reduced) {
        return {
          d: flat(),
          opacity: 0.85,
          gradient: [
            { at: 0, color: YOU },
            { at: 0.2, color: mix(0.2) },
            { at: 0.4, color: mix(0.4) },
            { at: 0.6, color: mix(0.6) },
            { at: 0.8, color: mix(0.8) },
            { at: 1, color: ANSWER },
          ],
        };
      }
      const cyc = (s % CREST_PERIOD) / CREST_TRAVEL;
      const sigma = Math.min(30, L * 0.07);
      const p = easeInOut(clamp01(cyc));
      const c = pad - 2 * sigma + p * (L + 4 * sigma);
      const h = cyc > 1 ? 0 : 5;
      const pts: [number, number][] = [];
      for (let i = 0; i <= N; i++) {
        const x = pad + (i / N) * L;
        pts.push([x, y0 - h * Math.exp(-(((x - c) / sigma) ** 2))]);
      }
      // The crest is the one coloured part: ember at its tail, ultramarine at its head, the blend
      // tipping toward Juno as it crosses (your words becoming its thought). The rest of the line rests.
      const at = clamp01((c - pad) / L);
      const win = (sigma * 2.2) / W;
      const cx = c / W;
      const live = cyc <= 1;
      return {
        d: pathOf(pts),
        opacity: 1,
        gradient: [
          { at: 0, color: REST },
          { at: cx - win, color: REST },
          { at: cx - win * 0.3, color: live ? mix(Math.max(0, at - 0.3)) : REST },
          { at: cx + win * 0.3, color: live ? mix(Math.min(1, at + 0.3)) : REST },
          { at: cx + win, color: REST },
          { at: 1, color: REST },
        ],
      };
    }
    case "interrupted": {
      // Before the cut Juno is talking; at `since` you speak over it.
      if (t < since) return frame("answering", t, since, W, H, reduced, answerer, level);
      const decay = reduced ? (s > 200 ? 0 : 1) : Math.exp(-s / CUT_DECAY);
      const front = reduced ? (s > 200 ? 1 : 0.5) : easeOut(clamp01(s / CUT_FRONT));
      const youLv = level(t, "you") * clamp01(s / 100);
      const ansLv = level(t, answerer) * decay;
      const a = wave(maxA * youLv, 1, t);
      const b = wave(maxA * ansLv, -1, t);
      const pts = a.map(([x, ya], i): [number, number] => {
        const u = i / N;
        const k = clamp01((u - front) / 0.08 + 0.5);
        return [x, y0 + (ya - y0) * (1 - k) + (b[i][1] - y0) * k];
      });
      const f = (pad + front * L) / W;
      return {
        d: pathOf(pts),
        opacity: 1,
        gradient: [
          { at: 0, color: YOU },
          { at: f - 0.06, color: YOU },
          { at: f - 0.02, color: mix(0.35) },
          { at: f + 0.02, color: mix(0.65) },
          { at: f + 0.06, color: ANSWER },
          { at: 1, color: ANSWER },
        ],
      };
    }
    case "connecting": {
      const p = reduced ? 1 : easeOut(clamp01(s / DRAW_IN));
      return { d: flat(1 - p, 1), opacity: 1, dash: "5 6", dashOffset: reduced ? 0 : -s * 0.018 };
    }
    case "reconnecting":
      return { d: flat(), opacity: 1, dash: "5 6", dashOffset: reduced ? 0 : -s * 0.018 };
    case "ended": {
      const p = reduced ? (s > 160 ? 0 : 1) : 1 - easeIn(clamp01(s / DRAW_OUT));
      return { d: p <= 0.001 ? "" : flat(1 - p, 1), opacity: 1 };
    }
    case "error": {
      // The string has broken: two halves, their inner ends sagging a little, still.
      const gap = Math.min(28, L * 0.08);
      const mid = pad + L / 2;
      const half = (from: number, to: number, droopAtEnd: boolean) => {
        const pts: [number, number][] = [];
        for (let i = 0; i <= 24; i++) {
          const u = i / 24;
          const x = from + (to - from) * u;
          const k = droopAtEnd ? u : 1 - u;
          pts.push([x, y0 + 3 * Math.pow(Math.max(0, (k - 0.55) / 0.45), 2)]);
        }
        return pathOf(pts);
      };
      return { d: `${half(pad, mid - gap / 2, true)}${half(mid + gap / 2, pad + L, false)}`, opacity: 1 };
    }
  }
}

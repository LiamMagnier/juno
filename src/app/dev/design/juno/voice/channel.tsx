"use client";

import * as React from "react";
import { useClock, useLevel, useTick } from "./clock";
import { passStarts, passTint, PASS } from "./continuum";
import type { Talker } from "./signal";
import type { StringPhase } from "./voice-string";

/*
 * THE CHANNEL: Alevr's voice signature (chosen in the lab, see lab.tsx and
 * RATIONALE.md).
 *
 * Two paths drawn in the Continuum's own geometry across the empty middle of
 * the composer's voice row: yours, anchored by the add button, and Alevr's,
 * anchored by the End disc. Each has a broad rounded head at its anchor and
 * tapers to a pointed end; the two pointed ends pass each other in the
 * middle, offset by a narrow open channel, the way the Continuum's blades
 * pass around its aperture without touching. Nothing about it is a meter and
 * nothing idles: a path moves only while its own audio moves through it.
 *
 *   Who is talking is WHICH path moves (independent input and output levels,
 *   MOTION_AND_THINKING), in which TONE (ember: you; presence ink: Alevr, or
 *   the agent's own colour in its thread), travelling from the speaker's
 *   anchor toward the listener. Both can move at once: talking over Alevr is
 *   drawn honestly as two voices, and Alevr's dies within 160 ms.
 *
 *   connecting    both paths draw out of their anchors in the decorative ink (560 ms) and stop short: the channel is open
 *   listening     the ends reach past each other (220 ms): connected. Yours in ember, still in silence, carrying your voice when you speak
 *   thinking      both rest; the Continuum's tonal handoff runs along them, ember along yours, handed over where the ends
 *                 pass, presence ink along Alevr's (14 segments, 70 ms apart, 220 ms tone: about 1.35 s across); the tone
 *                 then settles on the two ends in the channel: your words are with Alevr.
 *                 One pass when thinking starts, a re-pass per real step, never more than one per 1.6 s; otherwise still.
 *   answering     Alevr's path in presence ink, carrying its voice toward you
 *   muted         your path withdraws to its anchor (220 ms) and greys: you are off the line; Alevr's stays
 *   interrupted   Alevr's voice dies (90 ms decay) and greys (120 ms) as yours takes the line
 *   approval      the ends draw back a little (220 ms) and hold, yours still ember (the mic is open): the call waits on screen
 *   reconnecting  both grey and drawn back; each real reconnect attempt reaches once toward the other end
 *   error         both grey, drawn back further, still
 *   ended         both paths draw back into their anchors (360 ms) and the row is the composer again
 *
 * Every state is also words (the voice row's live region, voice-composer.tsx):
 * motion and tone are never the only signal.
 *
 * Reduced motion: nothing travels and nothing draws. A speaking path is a
 * still bow whose height is the level, read four times a second (the clock
 * steps); thinking is the settled pose without the pass; ends move by a 120 ms
 * fade-free jump. Tone still changes on fast.
 */

export type VoicePhase = StringPhase;

type Tone = "you" | "them" | "rest";
interface Role {
  you: { tone: "you" | "rest"; ext: number };
  them: { tone: "them" | "rest"; ext: number };
}

/** Each phase's settled pose: each path's tone and how far its end reaches (1: past the other end). */
const ROLE: Record<VoicePhase, Role> = {
  connecting: { you: { tone: "rest", ext: 0.84 }, them: { tone: "rest", ext: 0.84 } },
  listening: { you: { tone: "you", ext: 1 }, them: { tone: "rest", ext: 1 } },
  thinking: { you: { tone: "rest", ext: 1 }, them: { tone: "rest", ext: 1 } },
  answering: { you: { tone: "rest", ext: 1 }, them: { tone: "them", ext: 1 } },
  muted: { you: { tone: "rest", ext: 0.14 }, them: { tone: "rest", ext: 1 } },
  interrupted: { you: { tone: "you", ext: 1 }, them: { tone: "rest", ext: 1 } },
  approval: { you: { tone: "you", ext: 0.9 }, them: { tone: "rest", ext: 0.9 } },
  reconnecting: { you: { tone: "rest", ext: 0.78 }, them: { tone: "rest", ext: 0.78 } },
  error: { you: { tone: "rest", ext: 0.7 }, them: { tone: "rest", ext: 0.7 } },
  ended: { you: { tone: "rest", ext: 0 }, them: { tone: "rest", ext: 0 } },
};

/** Where a phase is entered from when nothing preceded it on screen (a state URL): connecting draws from nothing. */
const ENTERED_FROM: Partial<Record<VoicePhase, VoicePhase>> = { connecting: "ended" };

const N = 72;
const W_ACTIVE = 2.6;
const W_REST = 1.5;
const W_THINK = 2;
/** The paths are read as 14 segments for the handoff: at 70 ms a segment the pass crosses the row in about 1.35 s and its tone spans about a third of it. */
const SEGMENTS = 14;
const D_TONE = 120;
const D_REACH = 220;
const D_DRAW = 560;
const D_WITHDRAW = 360;
const CUT_DECAY = 90;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const easeOut = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
const easeIn = (x: number) => Math.pow(clamp01(x), 3);
const smooth = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

const YOU = "var(--vs-you)";
const THEM = "var(--vs-answer)";
const REST = "var(--vs-rest)";

/** A colour from a tint (0 rest, 1 full) and a hue (0 ember, 1 the answerer's ink). */
function colour(tint: number, hue: number): string {
  if (tint <= 0.004) return REST;
  const h = clamp01(hue);
  const ink = h <= 0.004 ? YOU : h >= 0.996 ? THEM : `color-mix(in oklab, ${YOU} ${Math.round((1 - h) * 100)}%, ${THEM})`;
  if (tint >= 0.996) return ink;
  return `color-mix(in oklab, ${REST} ${Math.round((1 - tint) * 100)}%, ${ink})`;
}

const toneTint = (t: Tone) => (t === "rest" ? 0 : 1);
const toneHue = (t: Tone, side: "you" | "them") => (t === "you" ? 0 : t === "them" ? 1 : side === "you" ? 0 : 1);

/** One path's outline: a tapered blade along a spine, round at the head, pointed at the end. */
function blade(spine: [number, number][], w0: number): string {
  const n = spine.length - 1;
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const a = spine[Math.max(0, i - 1)];
    const b = spine[Math.min(n, i + 1)];
    let tx = b[0] - a[0];
    let ty = b[1] - a[1];
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    const u = i / n;
    // A Continuum blade: full weight along the body, then one long taper to the point (the last 45%).
    const w = (w0 * (u < 0.55 ? 1 : Math.pow(1 - (u - 0.55) / 0.45, 0.85))) / 2;
    left.push([spine[i][0] - ty * w, spine[i][1] + tx * w]);
    right.push([spine[i][0] + ty * w, spine[i][1] - tx * w]);
  }
  // Round head: a half circle around the first spine point, away from the path.
  const [hx, hy] = spine[0];
  const [nx, ny] = spine[1];
  const ang = Math.atan2(ny - hy, nx - hx);
  const cap: [number, number][] = [];
  for (let k = 1; k < 8; k++) {
    const a = ang + Math.PI / 2 + (Math.PI * k) / 8;
    cap.push([hx + Math.cos(a) * (w0 / 2), hy + Math.sin(a) * (w0 / 2)]);
  }
  const pts = [...left, ...right.slice(0, n).reverse(), ...cap];
  let d = "";
  for (let i = 0; i < pts.length; i++) d += `${i ? "L" : "M"}${pts[i][0].toFixed(2)} ${pts[i][1].toFixed(2)}`;
  return d + "Z";
}

export interface VoiceChannelProps {
  phase: VoicePhase;
  /** Scene time at which this phase began. */
  since?: number;
  /** Thinking: times real activity arrived (the start, each new step); reconnecting: each attempt. */
  beats?: readonly number[];
  /** Who answers: Alevr, or an agent in its own thread (the path takes its colour from the thread). */
  answerer?: Talker;
  className?: string;
  /** Lab use: a fixed width instead of measuring. */
  width?: number;
  height?: number;
}

export function VoiceChannel({ phase, since = 0, beats, answerer = "alevr", className, width: fixedW, height = 34 }: VoiceChannelProps) {
  const clock = useClock();
  const level = useLevel();
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const youRef = React.useRef<SVGPathElement | null>(null);
  const themRef = React.useRef<SVGPathElement | null>(null);
  const stops = React.useRef<Record<"you" | "them", (SVGStopElement | null)[]>>({ you: [], them: [] });
  const gid = "jvc" + React.useId().replace(/[^a-zA-Z0-9]/g, "");
  const [w, setW] = React.useState(fixedW ?? 0);

  // The phase this one was entered from, for the reach and tone transitions.
  const [hist, setHist] = React.useState<{ phase: VoicePhase; from: VoicePhase }>(() => ({ phase, from: ENTERED_FROM[phase] ?? phase }));
  if (hist.phase !== phase) setHist({ phase, from: hist.phase });
  const from = hist.from;

  React.useLayoutEffect(() => {
    if (fixedW) return;
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.round(el.getBoundingClientRect().width)));
    ro.observe(el);
    setW(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, [fixedW]);

  const starts = React.useMemo(() => passStarts(beats && beats.length ? beats : [since]), [beats, since]);

  useTick(
    (t) => {
      if (w <= 0) return;
      const f = channelFrame({ phase, from, t, since, W: w, H: height, reduced: clock.reduced, answerer, level, starts });
      for (const side of ["you", "them"] as const) {
        const el = side === "you" ? youRef.current : themRef.current;
        if (!el) continue;
        const p = f[side];
        el.setAttribute("d", p.d);
        const g = svgRef.current?.querySelector(`#${gid}-${side}`);
        if (g) {
          g.setAttribute("x1", String(p.x1));
          g.setAttribute("x2", String(p.x2));
        }
        p.stops.forEach((c, i) => {
          const s = stops.current[side][i];
          if (s) s.style.stopColor = c;
        });
      }
    },
    [phase, from, since, w, height, answerer, level, starts, clock.reduced],
  );

  return (
    <svg
      ref={svgRef}
      className={["jv-channel", className].filter(Boolean).join(" ")}
      data-phase={phase}
      data-answerer={answerer}
      width={fixedW}
      height={height}
      viewBox={`0 0 ${Math.max(1, w)} ${height}`}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {(["you", "them"] as const).map((side) => (
          <linearGradient key={side} id={`${gid}-${side}`} gradientUnits="userSpaceOnUse" x1={0} y1={0} x2={Math.max(1, w)} y2={0}>
            {Array.from({ length: STOPS }, (_, i) => (
              <stop
                key={i}
                ref={(el) => {
                  stops.current[side][i] = el;
                }}
                offset={i / (STOPS - 1)}
                style={{ stopColor: REST }}
              />
            ))}
          </linearGradient>
        ))}
      </defs>
      <path ref={youRef} className="jv-channel__you" fill={`url(#${gid}-you)`} />
      <path ref={themRef} className="jv-channel__them" fill={`url(#${gid}-them)`} />
    </svg>
  );
}

const STOPS = 14;

/* —————————————————————————— One frame —————————————————————————— */

interface PathFrame {
  d: string;
  x1: number;
  x2: number;
  stops: string[];
}

export function channelFrame({
  phase,
  from,
  t,
  since,
  W,
  H,
  reduced,
  answerer,
  level,
  starts,
}: {
  phase: VoicePhase;
  from: VoicePhase;
  t: number;
  since: number;
  W: number;
  H: number;
  reduced: boolean;
  answerer: Talker;
  level: (t: number, who: Talker) => number;
  starts: readonly number[];
}): { you: PathFrame; them: PathFrame } {
  const s = Math.max(0, t - since);
  const pad = 2;
  const L = Math.max(1, W - pad * 2);
  const y0 = H / 2;
  const narrow = W < 300;
  const maxA = narrow ? 6 : 8;
  const g = narrow ? 2.25 : 2.5;
  const xc = pad + L / 2;
  const ov = Math.max(16, Math.min(56, L * 0.085));
  const segW = W / SEGMENTS;

  // The phase before: interrupted is entered from answering by definition (Alevr was talking when you spoke).
  const prev = ROLE[phase === "interrupted" ? "answering" : from];
  const now = ROLE[phase];

  const reachK = (() => {
    if (reduced) return s >= 120 ? 1 : 0;
    if (phase === "ended") return easeIn(s / D_WITHDRAW);
    if (phase === "connecting" && from === "ended") return easeOut(s / D_DRAW);
    return easeOut(s / D_REACH);
  })();
  const toneK = reduced ? (s >= 0 ? 1 : 0) : smooth(s / D_TONE);

  const sides = { you: null as unknown as PathFrame, them: null as unknown as PathFrame };
  for (const side of ["you", "them"] as const) {
    const role = now[side];
    const was = prev[side];
    let ext = lerp(was.ext, role.ext, reachK);
    // Reconnecting: each real attempt reaches once toward the other end (360 out, 360 back).
    if (phase === "reconnecting" && !reduced) {
      for (const a of starts) {
        const k = t - a;
        if (k >= 0 && k < D_WITHDRAW * 2) ext = Math.max(ext, role.ext + 0.16 * Math.sin((Math.PI * k) / (D_WITHDRAW * 2)));
      }
    }
    // Weight: a path carrying a voice is broad; at rest it is the hairline; while Alevr thinks both carry the handoff at 2 px.
    const weightOf = (ph: VoicePhase, tone: "you" | "them" | "rest") => (ph === "thinking" ? W_THINK : toneTint(tone) ? W_ACTIVE : W_REST);
    const w0 = lerp(weightOf(phase === "interrupted" ? "answering" : from, was.tone), weightOf(phase, role.tone), toneK);

    const dir = side === "you" ? 1 : -1;
    const headX = side === "you" ? pad + w0 / 2 : W - pad - w0 / 2;
    const fullTip = xc + dir * ov;
    const tipX = headX + (fullTip - headX) * ext;
    const base = y0 + (side === "you" ? g : -g);
    const plen = Math.abs(tipX - headX);

    // Whose sound moves this path, and how loud.
    let amp = 0;
    if (side === "you" && (phase === "listening" || phase === "approval" || phase === "interrupted")) {
      amp = maxA * level(t, "you") * (phase === "interrupted" ? clamp01(s / 100) : 1);
    }
    if (side === "them") {
      if (phase === "answering") amp = maxA * level(t, answerer);
      if (phase === "interrupted") amp = maxA * level(t, answerer) * (reduced ? (s > 160 ? 0 : 1) : Math.exp(-s / CUT_DECAY));
    }

    const spine: [number, number][] = [];
    if (plen < 0.6) {
      for (let i = 0; i <= N; i++) spine.push([headX + dir * (i / N) * 0.6, base]);
    } else {
      const k1 = Math.max(0.9, plen / 210);
      const k2 = k1 * 2.6;
      const tt = t / 1000;
      for (let i = 0; i <= N; i++) {
        const u = i / N;
        // The ends part a little where they pass, like the blades around the aperture: yours down, Alevr's up.
        const curl = (side === "you" ? 1 : -1) * 1.6 * Math.pow(smooth((u - 0.62) / 0.38), 1.6) * ext;
        let y = 0;
        if (amp > 0.01) {
          y = reduced
            ? -amp * 0.85 * Math.sin(Math.PI * u)
            : amp * Math.pow(Math.sin(Math.PI * u), 1.5) * (0.7 * Math.sin(2 * Math.PI * (u * k1 - tt * 0.95)) + 0.3 * Math.sin(2 * Math.PI * (u * k2 - tt * 1.8) + 1.3));
        }
        spine.push([headX + (tipX - headX) * u, base + curl + y]);
      }
    }

    // Tone along the path.
    const x1 = Math.min(headX, tipX) - w0;
    const x2 = Math.max(headX, tipX) + w0;
    const stops: string[] = [];
    for (let i = 0; i < STOPS; i++) {
      const x = x1 + ((x2 - x1) * i) / (STOPS - 1);
      let tint = lerp(toneTint(was.tone), toneTint(role.tone), toneK);
      let hue = toneTint(role.tone) ? toneHue(role.tone, side) : toneHue(was.tone, side);
      if (phase === "interrupted" && side === "them") {
        tint = 1 - toneK;
        hue = 1;
      }
      if (phase === "thinking") {
        // The handoff: the tone runs from your anchor along your path in ember, crosses where the ends
        // pass and runs on along Alevr's in its ink (each path keeps its own hue: no muddy mix), then
        // settles on the two ends in the channel: your words are with Alevr.
        const fade = toneTint(was.tone) * (1 - toneK);
        const tau = (x - pad) / segW;
        const pass = reduced ? 0 : Math.max(0, ...starts.map((st) => passTint(t - st - tau * PASS.stagger)));
        const reachedAt = (starts[0] ?? since) + tau * PASS.stagger + PASS.tone;
        const near = smooth(1 - (Math.abs(x - xc) - ov * 0.6) / 36);
        const settled = reduced ? near : t >= reachedAt ? near * smooth((t - reachedAt) / PASS.tone) : 0;
        tint = Math.max(fade, pass, settled);
        hue = side === "you" ? 0 : 1;
      }
      stops.push(colour(tint, hue));
    }
    sides[side] = { d: ext <= 0.002 ? "" : blade(spine, w0), x1, x2, stops };
  }
  return sides;
}

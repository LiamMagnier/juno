"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import type { VoicePhase } from "@/lib/voice-phase";

/**
 * The light around the screen while a call is live.
 *
 * WHAT IT IS FOR. It is the only thing on screen that says the call is alive,
 * and whose turn it is, without being read. The bar says it in words; this
 * says it from across the room, out of the corner of your eye, while you are
 * looking at something else. That is the whole job, and it is why it wraps the
 * window rather than sitting in the reading column: a call is a mode the whole
 * screen is in, not a widget inside the conversation.
 *
 * THE SHAPE. The bottom edge, and both sides for the lowest 30% of the window.
 * Not the full height — light all the way up encloses you, and the thing being
 * signalled is ambient, not urgent.
 *
 * WHY THREE EDGES AND NOT ONE PATH. A wave is drawn by pushing points inward
 * from an edge along that edge's normal. An earlier attempt walked a single
 * rounded perimeter so the light could turn the corners as one continuous
 * shape; a render harness killed it. However smoothly the normal is rotated
 * through a corner, the two sides end up aiming their crests at each other
 * across the gap, and it renders as hard diagonal facets with needles off the
 * arm tops. So each edge is drawn in its own frame, where the normal is
 * constant and the maths cannot go wrong, and the canvas transform does the
 * rotating. The three meet at the corners at full amplitude, which reads as a
 * mitre — a frame — instead of a tear.
 *
 * TWO LAYERS.
 *
 *   THE FIELD. Radial lobes sunk just outside the window edge, drifting
 *   against each other and swelling with the level. This is the ambient half:
 *   it fills the corners, so the junctions between the three ribbons are lit
 *   rather than merely adjacent.
 *
 *   THE RIBBONS. Two travelling waveforms per edge, filled toward the edge and
 *   faded away from it by a gradient. This is the half that reads as a voice
 *   rather than a lamp.
 *
 * Softness is in the paint, never in a filter. An early version put
 * `blur(9px)` over the whole canvas, which erased the 1.25px crest that is the
 * only part of the draw carrying the motion — the expensive work was paid for
 * and then destroyed. Do not reintroduce a filter.
 *
 * COLOUR AND MOTION BOTH CARRY THE STATE, because either alone is ambiguous at
 * the edge of vision. Your turn is the neutral ink moving quickly and
 * reactively; the thinking gap is halfway to the accent and moving slowly and
 * deliberately; Juno's turn is the full accent driven by the output audio.
 */

/** The quiet swell each phase keeps when no one is making a sound. */
const FLOOR: Record<VoicePhase, number> = {
  idle: 0,
  connecting: 0.14,
  listening: 0.09,
  "user-speaking": 0.09,
  thinking: 0.36,
  speaking: 0.16,
  muted: 0.04,
  error: 0,
};

/**
 * Where the phase sits on the one colour ramp the product has: 0 is the
 * neutral ink, 1 is the accent. Your voice is ink and Juno's is accent, and
 * the gap between them is literally between them — a mix along the existing
 * ramp, not a third hue invented for the occasion. (An earlier version rotated
 * the accent 152° to mark Juno's turn, which is a second brand colour in a
 * product with one.)
 */
const TONE: Record<VoicePhase, number> = {
  idle: 0,
  connecting: 0.35,
  listening: 0.12,
  "user-speaking": 0,
  thinking: 0.62,
  speaking: 1,
  muted: 0,
  error: 0,
};

/**
 * How fast the waves travel, per phase. Colour alone is not enough at the edge
 * of vision — a caller with any red-green deficiency, or simply not looking,
 * gets the state from the movement. Your turn is quick and reactive, the
 * thinking gap is slow and deliberate, muted barely moves.
 */
const TEMPO: Record<VoicePhase, number> = {
  idle: 0,
  connecting: 0.8,
  listening: 0.55,
  "user-speaking": 1.25,
  thinking: 0.42,
  speaking: 1,
  muted: 0.22,
  error: 0,
};

/**
 * One travelling wave. Two, on periods sharing no common factor and running in
 * opposite directions, is enough that the motion never resolves into a loop.
 */
const WAVES = [
  { frequency: 2.4, speed: 0.55, phase: 0, weight: 1, alpha: 0.42 },
  { frequency: 3.9, speed: -0.85, phase: 2.1, weight: 0.5, alpha: 0.26 },
] as const;

/**
 * One lobe of the ambient field, in viewport coordinates: `x`/`y` are shares of
 * width and height, and the radius is a share of the smaller dimension. They
 * sit outside the frame so only their inner falloff is on screen.
 */
const LOBES = [
  { x: 0.5, y: 1.06, radius: 0.95, drift: 0.08, speed: 0.21, alpha: 0.12 },
  { x: 0.0, y: 0.94, radius: 0.7, drift: 0.04, speed: -0.29, alpha: 0.11 },
  { x: 1.0, y: 0.94, radius: 0.7, drift: 0.04, speed: 0.34, alpha: 0.11 },
  { x: -0.04, y: 0.76, radius: 0.42, drift: 0.03, speed: 0.17, alpha: 0.07 },
  { x: 1.04, y: 0.76, radius: 0.42, drift: 0.03, speed: -0.23, alpha: 0.07 },
] as const;

/** How far up each side the light reaches, as a share of window height. */
const ARM_SHARE = 0.3;

/**
 * Share of an edge over which the ribbon fades out at its FREE end — the top of
 * an arm, and nothing on the bottom, which has no free end. Long, because a
 * short taper leaves a visible stub.
 */
const ARM_FADE = 0.62;

/** Share of the bottom edge over which the ribbon eases in at each corner. */
const CORNER_EASE = 0.05;

const smoothstep = (x: number) => x * x * (3 - 2 * x);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

function readHSL(el: Element, name: string): [number, number, number] | null {
  const raw = getComputedStyle(el).getPropertyValue(name).trim();
  const parts = raw.split(/\s+/);
  if (parts.length < 3) return null;
  const h = Number.parseFloat(parts[0]);
  const s = Number.parseFloat(parts[1]);
  const l = Number.parseFloat(parts[2]);
  return Number.isFinite(h) && Number.isFinite(s) && Number.isFinite(l) ? [h, s, l] : null;
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

export function VoiceAura({
  phase,
  levelRef,
}: {
  phase: VoicePhase;
  /** The live 0..1 audio envelope the call already computes. */
  levelRef: React.MutableRefObject<number>;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const phaseRef = React.useRef(phase);
  phaseRef.current = phase;

  // The layer is fixed to the window, so it is portalled to the body rather
  // than rendered where it is mounted: any ancestor with a transform, a filter
  // or a containment would otherwise become its containing block and clip it
  // back to the column.
  const [host, setHost] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => setHost(document.body), []);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;

    let width = 0;
    let height = 0;
    let dpr = 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      // Capped at 2: past that the extra pixels are invisible under a low-alpha
      // wash, and the fill rate is not.
      dpr = Math.min(2, window.devicePixelRatio || 1);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      paint(0);
    };

    // Theme and accent are read from the document rather than hardcoded, so a
    // swapped accent or a theme change reaches the light. Twice a second is far
    // more often than either can change, and costs one getComputedStyle.
    let accent: [number, number, number] = [15, 54, 46];
    let neutral: [number, number, number] = [48, 4, 40];
    let sinceColourRead = 1e9;
    const readColours = () => {
      accent = readHSL(document.documentElement, "--primary") ?? accent;
      neutral = readHSL(document.documentElement, "--muted-foreground") ?? neutral;
    };

    let clock = 0;
    let smooth = FLOOR[phaseRef.current];
    // Colour and tempo are eased rather than switched, so a turn boundary is a
    // sweep rather than a cut. Seeded from the phase: mounting mid-answer is
    // not a turn boundary, and starting from the caller's ink would wash Juno's
    // voice in the wrong colour and then correct itself in front of you.
    let tone = TONE[phaseRef.current];
    let tempo = TEMPO[phaseRef.current];

    /**
     * How strong the ribbon is at position `t` along an edge.
     *
     * The arms die out over most of their length so they frame the window
     * rather than enclosing it, and both edges stay near full strength at a
     * shared corner so the three ribbons meet as a mitre instead of leaving a
     * dark notch.
     */
    const windowAt = (t: number, arm: boolean) => {
      if (arm) {
        const foot = smoothstep(clamp01(t / CORNER_EASE));
        const head = smoothstep(clamp01((1 - t) / ARM_FADE));
        return foot * head;
      }
      return smoothstep(clamp01(Math.min(t, 1 - t) / CORNER_EASE));
    };

    /**
     * The three edges, each as the canvas transform that turns a local frame —
     * x along the edge, y away from it — into window coordinates. Doing it here
     * means the wave maths is written once, for one direction, and cannot
     * disagree between edges.
     */
    const edges = () => {
      const arm = height * ARM_SHARE;
      return [
        // Bottom: local x runs right, local y runs up.
        { length: width, arm: false, m: [1, 0, 0, -1, 0, height] as const },
        // Left arm: local x runs up, local y runs right.
        { length: arm, arm: true, m: [0, -1, 1, 0, 0, height] as const },
        // Right arm: local x runs up, local y runs left.
        { length: arm, arm: true, m: [0, -1, -1, 0, width, height] as const },
      ];
    };

    const paint = (dt: number) => {
      sinceColourRead += dt;
      if (sinceColourRead > 0.5) {
        readColours();
        sinceColourRead = 0;
      }

      const current = phaseRef.current;
      const audio = clamp01(levelRef.current || 0);
      // There is no audio to show during the thinking gap, so it holds a fixed
      // swell rather than going flat — the difference between "working on it"
      // and "died", which is the single worst moment in a voice product to get
      // wrong.
      const target = current === "thinking" ? FLOOR.thinking : Math.max(FLOOR[current], audio);
      // Asymmetric: the light climbs on a syllable and falls away slowly.
      // Matched rates flicker on every consonant. Exponential in elapsed time,
      // so a 120Hz display feels the same as a 60Hz one and a resize repaint
      // (dt = 0) advances nothing.
      const ease = (rate: number) => 1 - Math.exp(-rate * dt);
      smooth += (target - smooth) * ease(target > smooth ? 18 : 3.2);
      tone += (TONE[current] - tone) * ease(2.6);
      tempo += (TEMPO[current] - tempo) * ease(2.2);
      if (!reduced?.matches) clock += dt * tempo;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (current === "idle" || current === "error" || width === 0 || smooth <= 0.001) return;

      const [nh, ns, nl] = neutral;
      const [ah, as, al] = accent;
      const h = mix(nh, ah, tone);
      const s = mix(ns, as, tone);
      const l = mix(nl, al, tone);
      const paintTone = (a: number) => `hsl(${h} ${s}% ${l}% / ${a})`;

      // THE FIELD. Lobes sunk outside the frame, so only their inner falloff is
      // on screen and the light appears to come from beyond the window rather
      // than from a circle sitting on it.
      const span = Math.min(width, height);
      const strength = 0.45 + 0.55 * smooth;
      for (const lobe of LOBES) {
        const cx = width * lobe.x + width * lobe.drift * Math.sin(clock * lobe.speed);
        const cy = height * lobe.y;
        const r = Math.max(1, span * lobe.radius * (0.6 + 0.4 * smooth));
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, paintTone(lobe.alpha * strength));
        g.addColorStop(0.55, paintTone(lobe.alpha * 0.34 * strength));
        g.addColorStop(1, paintTone(0));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, width, height);
      }

      // THE RIBBONS. Reach is off the smaller dimension so the arms and the
      // bottom carry the same weight of light on any window shape.
      const reach = span * 0.2 * smooth;
      if (reach < 1) return;

      for (const edge of edges()) {
        if (edge.length < 1) continue;
        const [a, b, c, d, e, f] = edge.m;
        ctx.setTransform(a * dpr, b * dpr, c * dpr, d * dpr, e * dpr, f * dpr);

        // Sampled by length rather than by a fixed count: on a phone this is a
        // third of the points, and on a wide window the curve stays smooth.
        const steps = Math.max(20, Math.min(120, Math.round(edge.length / 10)));

        for (const wave of WAVES) {
          const points: [number, number][] = [];
          for (let i = 0; i <= steps; i += 1) {
            const t = i / steps;
            const swell =
              0.5 + 0.5 * Math.sin(t * wave.frequency * Math.PI * 2 + wave.phase + clock * wave.speed);
            points.push([t * edge.length, reach * wave.weight * swell * windowAt(t, edge.arm)]);
          }

          // The body, between the curve and the edge. The gradient is what makes
          // it soft — full strength on the edge, gone by the top of the wave's
          // reach. That falloff is what the blur was faking.
          const top = Math.max(1, reach * wave.weight);
          const g = ctx.createLinearGradient(0, 0, 0, top);
          g.addColorStop(0, paintTone(wave.alpha));
          // A mid stop, so the strongest light hugs the window edge and the
          // composer — which sits inside the ribbon's reach on a short window —
          // is lit rather than washed. A straight ramp put a fifth of full
          // strength across the text.
          g.addColorStop(0.4, paintTone(wave.alpha * 0.3));
          g.addColorStop(1, paintTone(0));
          ctx.beginPath();
          ctx.moveTo(0, 0);
          for (const [x, y] of points) ctx.lineTo(x, y);
          ctx.lineTo(edge.length, 0);
          ctx.closePath();
          ctx.fillStyle = g;
          ctx.fill();

          // The crest. Without it the moving boundary — the only part of the
          // draw carrying the motion — sits exactly where the gradient has faded
          // to nothing, and the whole thing reads as a lamp. Kept low enough
          // that it never becomes a wire.
          ctx.beginPath();
          points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
          ctx.lineWidth = 1.25;
          ctx.lineJoin = "round";
          ctx.strokeStyle = paintTone(wave.alpha * 0.32);
          ctx.stroke();
        }
      }
    };

    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      paint(dt);
      raf = requestAnimationFrame(frame);
    };

    // A hidden tab paints nothing. requestAnimationFrame throttles there
    // already, but the envelope would then take one enormous step on return.
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };

    readColours();
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    document.addEventListener("visibilitychange", onVisibility);
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [levelRef]);

  if (!host) return null;

  return createPortal(
    <div className="voice-aura" aria-hidden="true">
      <canvas ref={canvasRef} className="voice-aura__canvas" />
    </div>,
    host
  );
}

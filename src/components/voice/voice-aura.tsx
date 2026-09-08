"use client";

import * as React from "react";
import type { VoicePhase } from "@/lib/voice-phase";

/**
 * The light along the bottom of the conversation while a call is live.
 *
 * WHY IT CAME BACK. It was removed on the grounds that it was expensive and
 * decorative. That was half right — it WAS expensive — and wrong about the
 * rest: it is the only thing on screen that tells you, from across the room
 * and out of the corner of your eye, that the call is alive and whose turn it
 * is. The bar tells you in words; this tells you without reading.
 *
 * WHAT WAS ACTUALLY WRONG WITH IT, AND WITH THE FIRST ATTEMPT AT FIXING IT.
 *
 * The original drew three independent edges — left arm, bottom, right arm —
 * three waves each, every wave both filled and stroked: eighteen ~120-point
 * paths a frame at up to 2× DPR. Then it put `filter: blur(9px)` over the
 * whole canvas, which erased the 1.4px crest that the code itself correctly
 * called the thing that turns a glow into a wave. It also rotated the accent
 * 152° to mark Juno's turn, inventing a second brand colour.
 *
 * The first rebuild made it one continuous rounded perimeter so the light
 * could turn the corners as a single shape. That is a worse idea than it
 * sounds. A wave is drawn by pushing points inward along the edge normal; at a
 * corner the normal rotates 90°, and however smoothly you rotate it the two
 * arms end up pointing their crests at each other across a 100px gap. In the
 * render harness it produced hard diagonal facets across the bottom and thin
 * needles shooting off the tops of the arms. Perimeter-walking is the wrong
 * primitive: light does not have a normal.
 *
 * WHAT IT IS NOW. Two things, both anchored to the bottom edge, neither of
 * which has a corner in it.
 *
 *   THE FIELD. Three radial lobes centred just below the bottom edge, drifting
 *   slowly against each other, swelling with the level. This is the ambient
 *   half — it is what bleeds up the left and right of the column and gives the
 *   arms the original was drawing by hand, without a single point of geometry
 *   near a corner.
 *
 *   THE RIBBON. One travelling waveform across the bottom, filled downward and
 *   faded upward by a gradient, with a low crest stroke. This is the half that
 *   reads as a voice rather than a lamp. It is windowed to nothing at both
 *   ends, so there is no edge to see.
 *
 * Softness is in the paint, never in a filter: `blur()` on a canvas this size
 * is a full-surface pass every frame, and it is what killed the crest before.
 *
 * ONE ACCENT. Your voice is drawn in the neutral ink, Juno's in the accent,
 * crossfading at the turn. Colour marks state; that is the whole system.
 */

/** The quiet swell each phase keeps when no one is making a sound. */
const FLOOR: Record<VoicePhase, number> = {
  idle: 0,
  connecting: 0.12,
  listening: 0.08,
  "user-speaking": 0.08,
  thinking: 0.34,
  speaking: 0.14,
  muted: 0.03,
  error: 0,
};

/**
 * One travelling wave in the ribbon. Two, on periods sharing no common factor
 * and running in opposite directions, is enough that the motion never resolves
 * into a visible loop.
 */
const WAVES = [
  { frequency: 2.4, speed: 0.55, phase: 0, weight: 1, alpha: 0.42 },
  { frequency: 3.9, speed: -0.85, phase: 2.1, weight: 0.5, alpha: 0.26 },
] as const;

/** One lobe of the ambient field: where it sits, how big, how fast it drifts. */
const LOBES = [
  { at: 0.5, radius: 0.62, drift: 0.1, speed: 0.21, alpha: 0.13 },
  { at: 0.2, radius: 0.46, drift: 0.06, speed: -0.29, alpha: 0.1 },
  { at: 0.8, radius: 0.46, drift: 0.06, speed: 0.34, alpha: 0.1 },
] as const;

/** Share of the width over which the ribbon fades in and out at each end. */
const WINDOW_SHARE = 0.3;

const smoothstep = (x: number) => x * x * (3 - 2 * x);

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
    // more often than either can change and costs one getComputedStyle.
    let accent: [number, number, number] = [15, 54, 46];
    let neutral: [number, number, number] = [48, 4, 40];
    let sinceColourRead = 1e9;
    const readColours = () => {
      accent = readHSL(document.documentElement, "--primary") ?? accent;
      neutral = readHSL(document.documentElement, "--muted-foreground") ?? neutral;
    };

    let clock = 0;
    let smooth = FLOOR[phaseRef.current];
    // 0 = your voice, 1 = Juno's. Seeded from the phase rather than from zero:
    // the crossfade exists to soften a turn boundary, and mounting while Juno
    // is already talking is not one — starting at 0 would wash the answer in
    // the wrong colour and then correct itself in front of you.
    let speaker = phaseRef.current === "speaking" ? 1 : 0;

    /**
     * Zero at both ends, one across the middle. The ribbon has to die out
     * before the edge of the column or it terminates in a visible vertical cut.
     */
    const windowAt = (t: number) => {
      const edge = Math.min(t, 1 - t) / WINDOW_SHARE;
      return edge >= 1 ? 1 : smoothstep(Math.max(0, edge));
    };

    const paint = (dt: number) => {
      sinceColourRead += dt;
      if (sinceColourRead > 0.5) {
        readColours();
        sinceColourRead = 0;
      }

      const current = phaseRef.current;
      const audio = Math.max(0, Math.min(1, levelRef.current || 0));
      // There is no audio to show during the thinking gap, so it holds a fixed
      // swell rather than going flat — the difference between "working on it"
      // and "died".
      const target = current === "thinking" ? FLOOR.thinking : Math.max(FLOOR[current], audio);
      // Asymmetric: the light climbs on a syllable and falls away slowly.
      // Matched rates flicker on every consonant. Exponential in elapsed time,
      // so a 120Hz display feels the same as a 60Hz one and a resize repaint
      // (dt = 0) advances nothing.
      const ease = (rate: number) => 1 - Math.exp(-rate * dt);
      smooth += (target - smooth) * ease(target > smooth ? 18 : 3.2);
      speaker += ((current === "speaking" ? 1 : 0) - speaker) * ease(3);
      if (!reduced?.matches) clock += dt;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (current === "idle" || current === "error" || width === 0 || smooth <= 0.001) return;

      const [nh, ns, nl] = neutral;
      const [ah, as, al] = accent;
      const h = mix(nh, ah, speaker);
      const s = mix(ns, as, speaker);
      const l = mix(nl, al, speaker);
      const tone = (a: number) => `hsl(${h} ${s}% ${l}% / ${a})`;

      // THE FIELD. Radial lobes sunk below the bottom edge, so only their upper
      // half is on screen and the light appears to rise out of the composer
      // rather than to be a circle sitting behind it.
      const originY = height + height * 0.06;
      for (const lobe of LOBES) {
        const cx = width * (lobe.at + lobe.drift * Math.sin(clock * lobe.speed));
        const r = Math.max(1, width * lobe.radius * (0.55 + 0.45 * smooth));
        const g = ctx.createRadialGradient(cx, originY, 0, cx, originY, r);
        g.addColorStop(0, tone(lobe.alpha * (0.45 + 0.55 * smooth)));
        g.addColorStop(0.55, tone(lobe.alpha * 0.34 * (0.45 + 0.55 * smooth)));
        g.addColorStop(1, tone(0));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, width, height);
      }

      // THE RIBBON. One curve per wave across the bottom, filled downward.
      const reach = height * 0.26 * smooth;
      if (reach < 1) return;
      // Sampled by width rather than by a fixed count: on a phone this is a
      // third of the points, and on a wide column the curve stays smooth.
      const steps = Math.max(24, Math.min(120, Math.round(width / 10)));

      for (const wave of WAVES) {
        const points: [number, number][] = [];
        for (let i = 0; i <= steps; i += 1) {
          const t = i / steps;
          const swell =
            0.5 + 0.5 * Math.sin(t * wave.frequency * Math.PI * 2 + wave.phase + clock * wave.speed);
          points.push([t * width, height - reach * wave.weight * swell * windowAt(t)]);
        }

        // The body, between the curve and the bottom edge. The gradient is what
        // makes it soft — it is at full strength on the edge and gone by the
        // top of the wave's reach, which is the falloff a blur was faking.
        const top = height - reach * wave.weight;
        const g = ctx.createLinearGradient(0, height, 0, Math.min(top, height - 1));
        g.addColorStop(0, tone(wave.alpha));
        g.addColorStop(1, tone(0));
        ctx.beginPath();
        ctx.moveTo(0, height);
        for (const [x, y] of points) ctx.lineTo(x, y);
        ctx.lineTo(width, height);
        ctx.closePath();
        ctx.fillStyle = g;
        ctx.fill();

        // The crest. Without it the moving boundary — the only part of the draw
        // carrying the motion — sits exactly where the gradient has faded to
        // nothing, and the whole thing reads as a lamp. Kept low enough that it
        // never becomes a wire.
        ctx.beginPath();
        points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.lineWidth = 1.25;
        ctx.lineJoin = "round";
        ctx.strokeStyle = tone(wave.alpha * 0.32);
        ctx.stroke();
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

  return (
    <div className="voice-aura" aria-hidden="true">
      <canvas ref={canvasRef} className="voice-aura__canvas" />
    </div>
  );
}

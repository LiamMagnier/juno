"use client";

import * as React from "react";

export type VoiceAuraStatus = "idle" | "listening" | "thinking" | "speaking" | "error";

/** The quiet motion each state keeps when nothing is being said. */
const FLOOR: Record<VoiceAuraStatus, number> = {
  idle: 0.02,
  listening: 0.07,
  thinking: 0.22,
  speaking: 0.14,
  error: 0.02,
};

/** How far round the wheel Juno's voice sits from yours. */
const COMPANION_HUE_SHIFT = 152;

/**
 * One travelling wave. Three of these per edge, on periods that share no
 * common factor, is what stops the motion reading as a loop.
 */
type Wave = {
  /** Cycles across the edge's length. */
  frequency: number;
  /** Radians per second. Signed — mixing directions is most of the "organic". */
  speed: number;
  /** Starting offset, so the three never crest together. */
  phase: number;
  /** Share of the reach this wave contributes. */
  weight: number;
  /** Share of the alpha this wave contributes. */
  alpha: number;
};

const WAVES: Wave[] = [
  { frequency: 1.1, speed: 0.85, phase: 0, weight: 1, alpha: 0.5 },
  { frequency: 1.9, speed: -1.25, phase: 2.1, weight: 0.62, alpha: 0.34 },
  { frequency: 3.3, speed: 1.75, phase: 4.3, weight: 0.34, alpha: 0.22 },
];

/**
 * What the field should be doing, from the voice session's own state.
 *
 * Lives here rather than in the dock because the aura and the dock are no
 * longer in the same place in the tree — the aura has to be a sibling of the
 * composer to sit behind it, while the dock sits above — and two derivations of
 * "is Juno talking" that could disagree is exactly how the light ends up the
 * wrong colour.
 */
export function voiceAuraStatus(voice: {
  status: string;
  muted: boolean;
  assistantSpeaking: boolean;
}): VoiceAuraStatus {
  if (voice.status === "error") return "error";
  if (voice.status === "connecting" || voice.status === "reconnecting") return "thinking";
  if (voice.status !== "live" || voice.muted) return "idle";
  return voice.assistantSpeaking ? "speaking" : "listening";
}

/** 0 → 1 with the ends eased, so a wave's envelope has no visible corner. */
function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Reads `--primary` as its raw "H S% L%" triplet so we can shift the hue. */
function readHSL(el: HTMLElement, name: string): [number, number, number] | null {
  const raw = getComputedStyle(el).getPropertyValue(name).trim();
  const m = raw.match(/^(-?[\d.]+)\s+(-?[\d.]+)%\s+(-?[\d.]+)%$/);
  return m ? [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])] : null;
}

/**
 * The voice field: light that lives in the chat column and moves when someone
 * is talking.
 *
 * Three decisions worth stating.
 *
 * **It belongs to the column, not the window.** Voice is a property of this
 * conversation, so the light stops where the conversation stops — the sidebar
 * stays its own surface rather than being washed by whatever the chat is doing.
 * That is why this mounts inside the composer's `isolate` host and not on `document.body`.
 *
 * **It sits under the composer, at `z-index: -1`.** The composer is the control
 * you are using; light in front of it makes it harder to read for no gain. The
 * host establishes the stacking context that keeps this behind the composer
 * without also putting it behind the page.
 *
 * **Whose voice it is, is the colour.** Your turn is the accent; Juno's turn is
 * a hue a little over a third of the way round the wheel from it — derived from
 * `--primary` rather than fixed, so it still pairs when the accent is teal or
 * violet. The two crossfade, because a hard cut on every turn boundary reads as
 * a glitch rather than as an answer beginning.
 *
 * Drawn on a canvas rather than in CSS. The shape is a sum of travelling sine
 * waves sampled along each edge, which no gradient can express — the previous
 * build faked it with drifting ellipses and read as a lamp, not a voice.
 */
export function VoiceAura({
  status,
  levelRef,
}: {
  status: VoiceAuraStatus;
  levelRef?: React.MutableRefObject<number>;
}) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const statusRef = React.useRef(status);
  const liveLevelRef = React.useRef(levelRef);
  statusRef.current = status;
  liveLevelRef.current = levelRef;

  React.useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let width = 0;
    let height = 0;
    let dpr = 1;

    // Assigned below. `resize` has to be able to repaint — a box that changed
    // size shows a stretched stale frame until the next rAF otherwise, and on
    // mount there is no previous frame at all.
    let draw: () => void = () => {};

    const resize = () => {
      const rect = host.getBoundingClientRect();
      // Capped at 2: a 3x display gains nothing on a shape this soft and costs
      // 2.25x the fill rate, on the same thread that is decoding the audio.
      dpr = Math.min(2, window.devicePixelRatio || 1);
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      draw();
    };

    // Colour is read from the cascade, not hard-coded, so the accent picker and
    // the theme toggle both reach it. Re-read on a slow beat rather than every
    // frame: `getComputedStyle` is a style-recalc boundary and this is the only
    // thing on the page asking for one 60 times a second.
    let accent: [number, number, number] = [15, 54, 51];
    let isDark = false;
    let sinceColourRead = 1e9;
    const readColours = () => {
      const next = readHSL(document.documentElement, "--primary");
      if (next) accent = next;
      isDark = document.documentElement.classList.contains("dark");
    };

    let frame = 0;
    let last = performance.now();
    let clock = 0;
    let smooth = FLOOR[statusRef.current];
    // 0 = your voice, 1 = Juno's. Eased between turns, but *seeded* from the
    // status rather than from zero: the crossfade exists to soften a turn
    // boundary, and opening the panel while Juno is already talking is not one.
    // Starting at 0 there would wash the answer in the listener's colour and
    // then correct itself, which reads as the wrong colour rather than a fade.
    let speaker = statusRef.current === "speaking" ? 1 : 0;

    /**
     * Fills one edge with the wave stack.
     *
     * `project` maps (distance along the edge, height above it) to a point, so
     * the same maths draws the bottom band and both arms — the arms are the
     * bottom band stood on end, which is also why they read as one effect.
     */
    const drawEdge = (
      length: number,
      project: (along: number, out: number) => [number, number],
      reach: number,
      fade: (t: number) => number,
      gradient: CanvasGradient,
      crest: (a: number) => string,
    ) => {
      const steps = Math.max(24, Math.min(120, Math.round(length / 6)));
      for (const wave of WAVES) {
        const points: [number, number][] = [];
        for (let i = 0; i <= steps; i += 1) {
          const t = i / steps;
          const swell =
            0.52 + 0.48 * Math.sin(t * wave.frequency * Math.PI * 2 + wave.phase + clock * wave.speed);
          points.push(project(t * length, reach * wave.weight * swell * fade(t)));
        }

        // The body: everything between the edge and the wave, ramped out by the
        // gradient so the light looks like it is coming from the edge.
        ctx.beginPath();
        const [sx, sy] = project(0, 0);
        ctx.moveTo(sx, sy);
        for (const [x, y] of points) ctx.lineTo(x, y);
        const [ex, ey] = project(length, 0);
        ctx.lineTo(ex, ey);
        ctx.closePath();
        ctx.globalAlpha = wave.alpha;
        ctx.fillStyle = gradient;
        ctx.fill();

        // The crest. Without it this whole effect reads as a lamp: the fill's
        // own outer edge is where the gradient has already faded to nothing, so
        // the one part of the shape that carries the motion — the moving
        // boundary — is invisible. A thin bright line along it is what turns a
        // glow into a wave.
        ctx.beginPath();
        points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1.4;
        ctx.lineJoin = "round";
        ctx.strokeStyle = crest(wave.alpha * 0.62);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };

    /** Advances the simulation by `dt` seconds and paints one frame. */
    const step = (dt: number) => {
      sinceColourRead += dt;
      if (sinceColourRead > 0.5) {
        readColours();
        sinceColourRead = 0;
      }

      const currentStatus = statusRef.current;
      const audio = Math.max(0, Math.min(1, liveLevelRef.current?.current ?? 0));
      const target = Math.max(FLOOR[currentStatus], audio);
      // Asymmetric: the light climbs on a syllable and falls away slowly.
      // Matched rates flicker on every consonant.
      //
      // Exponential in dt rather than a fixed fraction per frame, so a 120Hz
      // display does not smooth twice as fast as a 60Hz one — and so `step(0)`,
      // the repaint a resize does, advances nothing at all.
      const ease = (rate: number) => 1 - Math.exp(-rate * dt);
      smooth += (target - smooth) * ease(target > smooth ? 21 : 3.6);

      const speakerTarget = currentStatus === "speaking" ? 1 : 0;
      speaker += (speakerTarget - speaker) * ease(3);

      if (!reduced.matches) clock += dt;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (currentStatus === "error") return;

      const [h0, s0, l0] = accent;
      const hue = h0 + COMPANION_HUE_SHIFT * speaker;
      const sat = s0 * (1 - 0.1 * speaker);
      // Warm charcoal swallows a low-alpha wash that warm paper shows plainly.
      const light = (l0 + 6 * speaker) * (isDark ? 1.06 : 0.98);
      // Warm paper needs almost as much help as warm charcoal: a low-alpha
      // wash reads on a 10%-lightness background far more easily than on a 97%
      // one, so the two multipliers are close rather than one being 1.
      const lit = smooth * (isDark ? 1.35 : 1.15);
      const tint = (a: number) => `hsl(${hue} ${sat}% ${light}% / ${a})`;

      // The arms are gone by roughly three-quarters of the way up this box,
      // which is a little above the composer — they frame the reading area
      // rather than enclosing it, and nothing above the composer is tinted.
      const armFade = (t: number) => smoothstep(0, 0.5, 0.78 - t);
      // The bottom band is quietest at the corners, where the arms take over.
      const bandFade = (t: number) => smoothstep(0, 0.2, t) * smoothstep(0, 0.2, 1 - t);

      // Kept narrow deliberately. A reach wide enough to be unmissable is also
      // wide enough that the three waves overlap into one mass, and the motion
      // — the whole point — disappears into a glow.
      // Wide dynamic range on purpose: at rest this should be a hairline of
      // light, and a loud syllable should be unmistakable from across the room.
      // A narrow range is what made the previous build look like a static lamp.
      const armReach = Math.min(width * 0.15, 96) * (0.2 + 0.8 * lit);
      const bandReach = Math.min(height * 0.46, 150) * (0.18 + 0.82 * lit);

      const band = ctx.createLinearGradient(0, height, 0, height - bandReach * 1.5);
      band.addColorStop(0, tint(0.34));
      band.addColorStop(0.45, tint(0.14));
      band.addColorStop(1, tint(0));

      const leftArm = ctx.createLinearGradient(0, 0, armReach * 1.6, 0);
      leftArm.addColorStop(0, tint(0.32));
      leftArm.addColorStop(0.5, tint(0.11));
      leftArm.addColorStop(1, tint(0));

      const rightArm = ctx.createLinearGradient(width, 0, width - armReach * 1.6, 0);
      rightArm.addColorStop(0, tint(0.32));
      rightArm.addColorStop(0.5, tint(0.11));
      rightArm.addColorStop(1, tint(0));

      // The crest is the same hue lifted toward the light, so it reads as the
      // bright edge of the same body rather than as a second colour.
      const crest = (a: number) =>
        `hsl(${hue} ${Math.min(100, sat * 1.1)}% ${Math.min(92, light + (isDark ? 22 : 10))}% / ${a})`;

      // Bottom: `along` runs left to right, `out` climbs.
      drawEdge(width, (along, out) => [along, height - out], bandReach, bandFade, band, crest);
      // Arms: `along` runs bottom to top, `out` pushes into the column.
      drawEdge(height, (along, out) => [out, height - along], armReach, armFade, leftArm, crest);
      drawEdge(height, (along, out) => [width - out, height - along], armReach, armFade, rightArm, crest);
    };

    // A repaint with no time passing: same frame, new size.
    draw = () => step(0);

    const render = (now: number) => {
      frame = requestAnimationFrame(render);
      // Clamped, not raw: rAF does not fire in a background tab, so `now - last`
      // across a hidden stretch is however long the reader was away. Unclamped,
      // the phase would teleport and the waves would jump on return.
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      step(dt);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  return (
    <div ref={hostRef} aria-hidden="true" data-status={status} className="voice-aura">
      <canvas ref={canvasRef} className="voice-aura__canvas" />
    </div>
  );
}

"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import {
  decayAuraDrive,
  readAura,
  readAuraLevel,
  subscribeAura,
  type AuraDrive,
  type AuraState,
} from "@/lib/aura";

/**
 * The light around the bottom of the window that says what the product is doing.
 *
 * WHAT IT IS FOR. It is the only thing on screen that says something is
 * happening, and what, without being read. The status row says it in words;
 * this says it from across the room, out of the corner of your eye, while you
 * are looking at something else. That is the whole job, and it is why it wraps
 * the window rather than sitting in the reading column: a call, or a reply
 * being written, is a mode the whole screen is in, not a widget inside the
 * conversation.
 *
 * IT IS NOT DECORATION. `idle` is genuinely absent — no paint, no animation
 * frames, nothing. If nothing is happening the light is off, which is the whole
 * answer to whether an always-mounted glow becomes wallpaper.
 *
 * THE SHAPE. The bottom edge, and both sides for the height of the band
 * (`--aura-band`, 38vh clamped). Never the top — and that is a structural fact
 * rather than a fade: there is no canvas up there. Light all the way up
 * encloses you, and the thing being signalled is ambient, not urgent.
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
 *   THE FIELD. Radial lobes sunk just outside the band's edges, drifting
 *   against each other and swelling with the amplitude. This is the ambient
 *   half: it fills the corners, so the junctions between the three ribbons are
 *   lit rather than merely adjacent.
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
 * reactively; thinking is halfway to the accent and moving slowly and
 * deliberately; an answer is the full accent at the fastest sustained travel.
 *
 * It takes no props. Everything it shows comes from the bus in `lib/aura.ts`,
 * because the two numbers that matter most — the microphone envelope and the
 * token cadence — change at frame rate, and routing those through React would
 * re-render the tree to move a canvas that is not in the tree.
 */

/** The quiet swell each state keeps when nothing is driving it. */
const FLOOR: Record<AuraState, number> = {
  idle: 0,
  listening: 0.09,
  user: 0.09,
  muted: 0.04,
  connecting: 0.14,
  thinking: 0.34,
  tool: 0.26,
  // Overridden per drive below: a call's output audio peaks far above its
  // floor, a token stream does not, so the stream rests slightly higher.
  answering: 0.2,
  done: 0,
  error: 0.22,
};

/** A streaming answer rests higher than a spoken one, which has real peaks. */
const ANSWERING_FLOOR: Record<AuraDrive, number> = { level: 0.16, cadence: 0.2, floor: 0.2 };

/**
 * Where the state sits on the one colour ramp the product has: 0 is the
 * neutral ink, 1 is the accent. Your voice is ink and Juno's is accent, and the
 * gap between them is literally between them — a mix along the existing ramp,
 * not a third hue invented for the occasion. `tool` sits below `thinking`
 * because a connector call is the product waiting on someone else.
 */
const TONE: Record<AuraState, number> = {
  idle: 0,
  listening: 0.12,
  user: 0,
  muted: 0,
  connecting: 0.35,
  thinking: 0.62,
  tool: 0.45,
  answering: 1,
  done: 1,
  error: 0,
};

/** The second ramp, toward `--destructive`. The only other hue this may draw. */
const ALARM: Record<AuraState, number> = {
  idle: 0,
  listening: 0,
  user: 0,
  muted: 0,
  connecting: 0,
  thinking: 0,
  tool: 0,
  answering: 0,
  done: 0,
  error: 1,
};

/**
 * How fast the waves travel, per state. Colour alone is not enough at the edge
 * of vision — someone with a red-green deficiency, or simply not looking, gets
 * the state from the movement. At half an answer's tempo, `thinking` is
 * distinguishable from `answering` with no colour information at all. `error`
 * crawls: a failure should read as "stopped", never as "urgent", and it must
 * never strobe.
 */
const TEMPO: Record<AuraState, number> = {
  idle: 0,
  listening: 0.55,
  user: 1.25,
  muted: 0.22,
  connecting: 0.8,
  thinking: 0.4,
  tool: 0.3,
  answering: 1,
  done: 0.7,
  error: 0.1,
};

/** A streaming answer travels a hair faster than a spoken one. */
const ANSWERING_TEMPO: Record<AuraDrive, number> = { level: 1, cadence: 1.05, floor: 1.05 };

/**
 * The states with no drive of their own breathe instead of sitting flat. The
 * periods are deliberately NOT rungs of the `--dur-*` ladder: that ladder is
 * for transitions, which have an endpoint, and a breath has none.
 */
const BREATH: Partial<Record<AuraState, { amp: number; period: number }>> = {
  connecting: { amp: 0.05, period: 2.4 },
  thinking: { amp: 0.1, period: 3.4 },
  tool: { amp: 0.06, period: 5.2 },
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
 * One lobe of the ambient field, in BAND coordinates: `x`/`y` are shares of the
 * layer's width and of the band's height, and the radius is a share of `span`.
 * They sit outside the band so only their inner falloff is on screen.
 */
const LOBES = [
  { x: 0.5, y: 1.16, radius: 0.95, drift: 0.08, speed: 0.21, alpha: 0.12 },
  { x: 0.0, y: 0.84, radius: 0.7, drift: 0.04, speed: -0.29, alpha: 0.11 },
  { x: 1.0, y: 0.84, radius: 0.7, drift: 0.04, speed: 0.34, alpha: 0.11 },
  { x: -0.04, y: 0.37, radius: 0.42, drift: 0.03, speed: 0.17, alpha: 0.07 },
  { x: 1.04, y: 0.37, radius: 0.42, drift: 0.03, speed: -0.23, alpha: 0.07 },
] as const;

/**
 * How far up each side the light reaches, as a share of the BAND — not of the
 * window. The band is the reach now: it is the only thing the layer owns, so a
 * second share of a second dimension would be two places to change one answer.
 */
const ARM_OF_BAND = 0.88;

/**
 * Share of an edge over which the ribbon fades out at its FREE end — the top of
 * an arm, and nothing on the bottom, which has no free end. Long, because a
 * short taper leaves a visible stub.
 */
const ARM_FADE = 0.62;

/** Share of the bottom edge over which the ribbon eases in at each corner. */
const CORNER_EASE = 0.05;

/**
 * A call is a mode you deliberately entered, and the light is the main thing
 * telling you it is live. A reply streaming is not, and the light must never
 * compete with the text it is announcing — so everything else paints at 62%.
 */
const PRESENCE_VOICE = 1;
const PRESENCE_AMBIENT = 0.62;

/**
 * Share of the band over which the light is erased at its TOP edge.
 *
 * The lobes are far larger than the band — the biggest is a ~570px radius on a
 * 342px-tall layer — so they reach the top of the canvas still carrying a few
 * hundredths of alpha, and a canvas that stops has a HARD EDGE where a viewport
 * canvas had room to fall off. Measured on warm paper it was a 3-to-5 level
 * step running the full width of the window: small, and unmistakably a seam.
 *
 * Erased here rather than with a CSS mask, because softness in this layer lives
 * in the paint and a second mechanism is a second place for it to disagree. At
 * 0.20 the cut ends just below where the arms' crests begin, so everything it
 * touches is already under 3% alpha, and it costs one fill over a fifth of the
 * band — about 2% of what the five lobes already cost.
 */
const TOP_FADE = 0.2;

/** Below this the light is indistinguishable from off, and the loop parks. */
const OFF_EPSILON = 0.004;

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

/**
 * Hue is a circle, and this is the bug that made the aura turn green.
 *
 * Interpolating 48° (`--muted-foreground`) → 249° (violet `--primary`) on the
 * NUMBER LINE passes through 148° at the halfway point, so every state change
 * on a violet accent swung through a colour the product does not own. Teal,
 * sage and juniper did the same. The short way round from 48° to 249° is 159°
 * in the other direction, through rose — inside the warm family the whole
 * palette lives in.
 */
const mixHue = (a: number, b: number, t: number) => {
  const d = ((b - a + 540) % 360) - 180;
  return (a + d * t + 360) % 360;
};

export function AmbientAura() {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const wrapRef = React.useRef<HTMLDivElement | null>(null);

  // The layer is fixed to the window, so it is portalled to the body rather
  // than rendered where it is mounted: any ancestor with a transform, a filter
  // or a containment would otherwise become its containing block and clip it
  // back to a column.
  const [host, setHost] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => setHost(document.body), []);

  // KEYED ON `host`, and that is load-bearing rather than tidy. The portal does
  // not exist on the first render — `host` is null until the effect above sets
  // it — so an effect with an empty dependency list runs once, against a canvas
  // ref that is still null, and never runs again. The layer then mounts, sizes
  // itself to nothing, and paints a 300×150 default backing store off-screen.
  React.useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!host || !canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const hasMatchMedia = typeof window.matchMedia === "function";
    const reducedQuery = hasMatchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    // Read into a variable rather than consulted through the MediaQueryList on
    // every frame, and kept current by a `change` listener: the previous
    // version captured the value at effect setup and never re-read it, so
    // flipping the OS preference mid-session did nothing at all.
    let reduced = reducedQuery?.matches ?? false;
    const onReducedChange = (e: MediaQueryListEvent) => {
      reduced = e.matches;
    };
    reducedQuery?.addEventListener("change", onReducedChange);

    let width = 0;
    let height = 0;
    let dpr = 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      // Capped at 2: past that the extra pixels are invisible under a low-alpha
      // wash, and the fill rate is not. Then capped again by total width —
      // on an ultrawide at 2× this is the difference between one millisecond a
      // frame and three, for resolution nobody can see in a ≤0.26-alpha wash.
      dpr = Math.min(2, window.devicePixelRatio || 1);
      if (rect.width * dpr > 3200) dpr = Math.max(1, 3200 / rect.width);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      paint(0);
    };

    /**
     * The three tokens the light is made of, read off `<html>` rather than
     * hardcoded so a swapped accent or a theme change reaches it.
     *
     * NOT A POLL. The previous version ran `getComputedStyle` twice a second
     * for the life of the layer — a style-recalc boundary in the steady state,
     * for two values that change only when the user flips the theme or the
     * accent. Both of those fire real DOM mutations, so they are observed
     * instead and the recalc disappears from the steady state entirely.
     *
     * The fallbacks are the light-theme coral values, so a failed read looks
     * like the default rather than like nothing.
     */
    let accent: [number, number, number] = [15, 54, 46];
    let neutral: [number, number, number] = [48, 4, 40];
    let danger: [number, number, number] = [11, 51, 48];
    const readColours = () => {
      const root = document.documentElement;
      accent = readHSL(root, "--primary") ?? accent;
      neutral = readHSL(root, "--muted-foreground") ?? neutral;
      danger = readHSL(root, "--destructive") ?? danger;
    };

    let clock = 0;
    /** Wall-clock seconds, for the breath — which must not speed up with the
     *  travel, or "thinking" would pulse faster the moment the tempo eased in. */
    let wall = 0;
    let previous: AuraState = readAura().state;
    let smooth = 0;
    // Colour, tempo and presence are eased rather than switched, so a state
    // boundary is a sweep rather than a cut. Seeded from the state at mount:
    // mounting mid-answer is not a turn boundary, and starting from the
    // caller's ink would wash Juno's voice in the wrong colour and then correct
    // itself in front of you.
    let tone = TONE[previous];
    let alarm = ALARM[previous];
    let tempo = TEMPO[previous];
    let presence = readAura().source === "voice" ? PRESENCE_VOICE : PRESENCE_AMBIENT;

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
     * x along the edge, y away from it — into layer coordinates. Doing it here
     * means the wave maths is written once, for one direction, and cannot
     * disagree between edges. `height` is the BAND, not the window.
     */
    const edges = () => {
      const arm = height * ARM_OF_BAND;
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
      const now = readAura();
      const state = now.state;
      const cadence = decayAuraDrive(dt);
      wall += dt;

      // Exponential in elapsed time, so a 120Hz display feels the same as a
      // 60Hz one and a resize repaint (dt = 0) advances nothing.
      const ease = (rate: number) => 1 - Math.exp(-rate * dt);

      // The closing swell starts from something, so the end of a turn is a
      // confirming rise that fades rather than a flat line going out.
      if (state === "done" && previous !== "done") smooth = Math.max(smooth, 0.42);
      previous = state;

      let target: number;
      let attack: number;
      let release: number;
      if (state === "idle") {
        target = 0;
        attack = 3.2;
        release = 3.2;
      } else if (state === "done") {
        target = 0;
        attack = 2.6;
        release = 2.6;
      } else if (now.drive === "level") {
        // A live microphone has to stay visibly live even under reduced motion:
        // this is informational, not decorative.
        target = Math.max(FLOOR[state], readAuraLevel());
        // Asymmetric: the light climbs on a syllable and falls away slowly.
        // Matched rates flicker on every consonant.
        attack = 18;
        release = 3.2;
      } else if (now.drive === "cadence") {
        const floor = ANSWERING_FLOOR.cadence;
        // Under reduced motion the stream holds its floor: a per-token flicker
        // is exactly the motion the preference is about. The colour and the
        // height still say "answering".
        target = reduced ? floor : Math.max(floor, cadence);
        // Half the level attack, so the light does not chatter once per token.
        attack = 9;
        release = 2.4;
      } else {
        const floor = state === "answering" ? ANSWERING_FLOOR.floor : FLOOR[state];
        const breath = BREATH[state];
        // Pinned at the middle of its range under reduced motion — still the
        // state's own height and colour, just not pulsing.
        target =
          breath && !reduced
            ? floor + breath.amp * (0.5 - 0.5 * Math.cos((2 * Math.PI * wall) / breath.period) - 0.5) * 2
            : floor;
        attack = 3;
        release = 2;
      }

      smooth += (target - smooth) * ease(target > smooth ? attack : release);

      // Held, not eased toward `idle`'s row: the light is fading out, and
      // sweeping its colour back to ink on the way would recolour a state the
      // user is still watching disappear. An expired error fades out red, which
      // is the "one pulse, then gone" the brief asks for.
      if (state !== "idle") {
        const toneRate = state === "done" ? 4 : 2.6;
        tone += (TONE[state] - tone) * ease(toneRate);
        // Rises faster than it falls: a failure should land, then let go.
        alarm += (ALARM[state] - alarm) * ease(ALARM[state] > alarm ? 4 : 1.6);
        const tempoTarget = state === "answering" ? ANSWERING_TEMPO[now.drive] : TEMPO[state];
        tempo += (tempoTarget - tempo) * ease(2.2);
        const presenceTarget = now.source === "voice" ? PRESENCE_VOICE : PRESENCE_AMBIENT;
        presence += (presenceTarget - presence) * ease(2);
      }

      // Reduced motion freezes the travel and keeps the envelope: the waves
      // stop moving but keep their shape, so the layer is a still coloured
      // envelope whose height and hue change per state. It never becomes a flat
      // line, because it is information.
      if (!reduced) clock += dt * tempo;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (width === 0 || height === 0 || smooth <= 0.001) return;

      const [nh, ns, nl] = neutral;
      const [ah, as, al] = accent;
      const [dh, ds, dl] = danger;
      // Ink → accent by tone, then that → destructive by alarm. Hue on the
      // short arc both times (see `mixHue`); saturation and lightness are
      // linear, where a straight mix is correct.
      const bh = mixHue(nh, ah, tone);
      const h = mixHue(bh, dh, alarm);
      const s = mix(mix(ns, as, tone), ds, alarm);
      const l = mix(mix(nl, al, tone), dl, alarm);
      const paintTone = (a: number) => `hsl(${h} ${s}% ${l}% / ${a * presence})`;

      // THE FIELD. Lobes sunk outside the band, so only their inner falloff is
      // on screen and the light appears to come from beyond the window rather
      // than from a circle sitting on it. `H * 2.4` reconstructs the window
      // height the old full-viewport canvas was measuring, so the light is the
      // same size it always was — the canvas shrank, the light did not.
      const span = Math.min(width, height * 2.4);
      const strength = 0.45 + 0.55 * smooth;
      for (const lobe of LOBES) {
        // Drift is motion for its own sake; reduced motion drops it and keeps
        // the lobes where they are.
        const cx = width * lobe.x + (reduced ? 0 : width * lobe.drift * Math.sin(clock * lobe.speed));
        const cy = height * lobe.y;
        const r = Math.max(1, span * lobe.radius * (0.6 + 0.4 * smooth));
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, paintTone(lobe.alpha * strength));
        g.addColorStop(0.55, paintTone(lobe.alpha * 0.34 * strength));
        g.addColorStop(1, paintTone(0));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, width, height);
      }

      const reach = span * 0.2 * smooth;
      if (reach >= 1) paintRibbons(reach, paintTone);
      fadeTop();
    };

    /** The two travelling waveforms on each of the three edges. */
    const paintRibbons = (reach: number, paintTone: (a: number) => string) => {
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
          // composer — which sits inside the ribbon's reach — is lit rather than
          // washed. A straight ramp put a fifth of full strength across the text.
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
          // that it never becomes a wire, and the same hue: never a second colour.
          ctx.beginPath();
          points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
          ctx.lineWidth = 1.25;
          ctx.lineJoin = "round";
          ctx.strokeStyle = paintTone(wave.alpha * 0.32);
          ctx.stroke();
        }
      }
    };

    /** See TOP_FADE: the band has to end somewhere, and not on a hard line. */
    const fadeTop = () => {
      const fade = height * TOP_FADE;
      if (fade < 1) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cut = ctx.createLinearGradient(0, 0, 0, fade);
      cut.addColorStop(0, "rgba(0,0,0,1)");
      cut.addColorStop(1, "rgba(0,0,0,0)");
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = cut;
      ctx.fillRect(0, 0, width, fade);
      ctx.globalCompositeOperation = "source-over";
    };

    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      paint(dt);
      // THE WHOLE POINT OF AN AMBIENT LIGHT BEING FREE WHEN NOTHING HAPPENS.
      // Once the state is idle and the release has run out, the loop stops —
      // no rescheduled frame, one final clear — and an app sitting at a
      // greeting screen schedules zero animation frames from this component.
      if (readAura().state === "idle" && smooth < OFF_EPSILON) {
        smooth = 0;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(frame);
    };

    const wake = () => {
      if (raf || document.hidden) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };

    // A hidden tab paints nothing. requestAnimationFrame throttles there
    // already, but the envelope would then take one enormous step on return.
    //
    // `smooth > 0` IS PART OF THE CONDITION, and it is not defensive. The state
    // can go idle while the tab is in the background — an error expires on a
    // timer, a turn finishes — and the loop is not running to notice. Waking
    // only for a non-idle state left the light frozen on screen at whatever it
    // was painting when the tab lost focus, with no loop left to release it:
    // a failed turn that stayed lit for the rest of the session. Residual
    // amplitude is work to do, so it wakes, releases and parks itself.
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (readAura().state !== "idle" || smooth > 0) {
        wake();
      }
    };

    readColours();
    resize();

    // Exactly when the colour can change, and never in between: next-themes
    // writes `class` on <html>, the accent picker writes `data-accent`, and a
    // "system" theme follows the OS query.
    const colourObserver = new MutationObserver(readColours);
    colourObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-accent"] });
    const schemeQuery = hasMatchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    const onScheme = () => readColours();
    schemeQuery?.addEventListener("change", onScheme);

    // On the WRAPPER, not the canvas: the canvas is sized from the wrapper, so
    // observing the thing being sized would be observing the effect.
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    document.addEventListener("visibilitychange", onVisibility);
    const unsubscribe = subscribeAura((r) => {
      if (r.state !== "idle") wake();
    });
    if (readAura().state !== "idle") wake();

    return () => {
      cancelAnimationFrame(raf);
      unsubscribe();
      observer.disconnect();
      colourObserver.disconnect();
      schemeQuery?.removeEventListener("change", onScheme);
      reducedQuery?.removeEventListener("change", onReducedChange);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [host]);

  if (!host) return null;

  // No role, no focusable content, `aria-hidden`: every state it shows is
  // already announced elsewhere — PHASE_ANNOUNCEMENT for a call, the activity
  // timeline for a chat — so it adds nothing to the accessibility tree by
  // design. `pointer-events: none` lives in the class; it can never take a click.
  return createPortal(
    <div ref={wrapRef} className="ambient-aura" aria-hidden="true">
      <canvas ref={canvasRef} className="ambient-aura__canvas" />
    </div>,
    host
  );
}

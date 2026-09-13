"use client";

import * as React from "react";
import {
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
 * THE SHAPE. The bottom edge and both sides, over the whole content column —
 * which is what `<main>` is, and what a call is a mode of. It is BEHIND the
 * conversation, not over it: `z-index: 0` under a `z-[1]` content wrapper, so
 * the transcript, the composer and every popover read on top of the light
 * rather than through it. Never the top: the arms taper out before they get
 * there (ARM_FADE), because light all the way round encloses you and the
 * thing being signalled is ambient, not urgent.
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
 *   THE RIM. Pools of light along each edge, drifting and breathing against
 *   each other at speeds sharing no common factor (POOLS). This is the half
 *   that reads as a voice rather than a lamp. It was a travelling waveform
 *   once; see the POOLS header for why it is not one now.
 *
 * Softness is in the paint, never in a filter. An early version put
 * `blur(9px)` over the whole canvas, on top of a draw whose every edge is
 * already a gradient falloff — paying twice for one effect, and paying the
 * second time per frame. Do not reintroduce a filter.
 *
 * COLOUR AND MOTION BOTH CARRY THE STATE, because either alone is ambiguous at
 * the edge of vision — and because one of the three parties here is the person
 * in the room, who may not be looking at the screen at all.
 *
 *   You speaking      the accent, and the only ink driven by a live signal:
 *                     it climbs on a syllable (attack 18) and falls away
 *                     slowly (release 3.2), so the movement is YOURS.
 *   Juno thinking     `--ultra`, breathing on a 3.4s cycle at 0.4 tempo —
 *                     slow, regular, going nowhere, which is what waiting is.
 *   Juno answering    `--source`, resting high and travelling at full tempo.
 *
 * Three inks and three motions, and each pair is legible without the other.
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
const ANSWERING_FLOOR: Record<AuraDrive, number> = { level: 0.16, floor: 0.2 };

/**
 * WHICH INK EACH STATE SPEAKS IN.
 *
 * This replaced a single 0..1 ramp from the neutral ink to the accent, plus a
 * second ramp toward `--destructive`. One ramp can only ever say "more" or
 * "less" of one thing, so `thinking` and `answering` were the same colour at
 * different strengths — and the one state that should unmistakably be the
 * brand's own, your turn, sat at 0: grey.
 *
 * Three parties, three inks (the tokens are defined in globals.css):
 *
 *   you       your voice, in the accent. The product is listening to you
 *             specifically, and that is the one moment it should look it.
 *   thinking  Juno working, in `--ultra`. Far enough from the accent that
 *             "working" can never be misread as "your turn" at a glance.
 *   juno      Juno answering, in `--source` — the ink that already means
 *             "this came from somewhere" everywhere else in the product.
 *   alarm     a failure, in `--destructive`. Its own ink, never a mix.
 *
 * `quiet` is the neutral ink: a call that is up with nobody speaking is
 * PRESENT without claiming a party, which is exactly what listening is.
 */
type AuraInk = "you" | "thinking" | "juno" | "alarm" | "quiet";

const INK: Record<AuraState, AuraInk> = {
  idle: "quiet",
  listening: "quiet",
  user: "you",
  muted: "quiet",
  connecting: "thinking",
  thinking: "thinking",
  // A connector call is Juno working on your behalf, so it takes the working
  // ink rather than a fifth one nobody would learn.
  tool: "thinking",
  answering: "juno",
  done: "juno",
  error: "alarm",
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
const ANSWERING_TEMPO: Record<AuraDrive, number> = { level: 1, floor: 1.05 };

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
 * THE RIM: pools of light along an edge, not a wave and not a band.
 *
 * TWO THINGS HAVE BEEN TRIED AND BOTH READ AS A WIDGET.
 *
 * First, two travelling sines per edge at frequency 2.4 and 3.9, each filled
 * to the edge and finished with a 1.25px crest stroke. The crest was doing all
 * the work — the only crisp thing in the layer — and a crisp sine along the
 * bottom of a window is an audio visualiser.
 *
 * Then, stacked gradient bands whose top boundary undulated slowly, with no
 * stroke at all. That is worse, and the reason is worth writing down because
 * it is not obvious from the code: a linear gradient runs from the edge to a
 * FIXED height, but the polygon is cut at a height that VARIES along the edge.
 * Wherever the cut falls short of the gradient's zero point, the fill stops at
 * whatever alpha it had reached — a hard line. Rendered, that is a field of
 * grey facets with straight diagonal seams, like creased paper.
 *
 * The fix is not a third boundary shape. It is to stop having a boundary.
 *
 * Every pool below is a RADIAL gradient whose centre is sunk just outside the
 * edge, so only its inner falloff is on screen and its alpha reaches zero on
 * its own in every direction. Nothing is clipped, so nothing can show a cut.
 * The light is brighter where pools overlap and dimmer between them, and the
 * pools drift along the edge at speeds sharing no common factor — so what the
 * eye sees is a rim breathing unevenly, which is what a room lit from beyond
 * its edges does. This is the same construction as `LOBES` below, which has
 * always been the half of this layer that looked right.
 *
 * `at` is the position along the edge, 0 at the corner; `sink` is how far the
 * centre sits outside it, as a share of the radius — deeper means flatter and
 * wider. `spread` is the radius as a share of the reach. `swing` is how far it
 * travels, as a share of the edge.
 */
const POOLS = [
  { at: 0.06, spread: 1.15, sink: 0.4, swing: 0.06, speed: 0.23, phase: 0.0, alpha: 0.34 },
  { at: 0.26, spread: 1.75, sink: 0.55, swing: 0.09, speed: -0.17, phase: 1.7, alpha: 0.24 },
  { at: 0.44, spread: 1.05, sink: 0.34, swing: 0.07, speed: 0.29, phase: 3.4, alpha: 0.4 },
  { at: 0.66, spread: 1.85, sink: 0.58, swing: 0.1, speed: -0.21, phase: 5.0, alpha: 0.22 },
  { at: 0.82, spread: 1.1, sink: 0.37, swing: 0.06, speed: 0.13, phase: 2.3, alpha: 0.36 },
  { at: 0.96, spread: 1.4, sink: 0.48, swing: 0.05, speed: -0.31, phase: 4.1, alpha: 0.28 },
] as const;

/**
 * How much a pool's own brightness breathes, and how fast.
 *
 * Separate from the drift because they are different senses of motion: drift
 * moves where the light IS, breath moves how much of it there is. Together
 * they are why the rim never settles into a pattern you can name, which is the
 * whole difference between ambient light and an animation.
 */
const POOL_BREATH = 0.34;
const POOL_BREATH_SPEED = 0.62;

/**
 * One lobe of the ambient field, in BAND coordinates: `x`/`y` are shares of the
 * layer's width and of the band's height, and the radius is a share of `span`.
 * They sit outside the band so only their inner falloff is on screen.
 */
const LOBES = [
  { x: 0.5, y: 1.18, radius: 1.1, drift: 0.08, speed: 0.21, alpha: 0.13 },
  { x: -0.02, y: 0.86, radius: 0.82, drift: 0.04, speed: -0.29, alpha: 0.12 },
  { x: 1.02, y: 0.86, radius: 0.82, drift: 0.04, speed: 0.34, alpha: 0.12 },
  // The high pair carries the field above the midline. They are the reason
  // the layer reads as a room rather than as a glow at the bottom of one,
  // and they are deliberately the faintest things here: everything they
  // touch is text.
  { x: -0.06, y: 0.3, radius: 0.56, drift: 0.03, speed: 0.17, alpha: 0.075 },
  { x: 1.06, y: 0.3, radius: 0.56, drift: 0.03, speed: -0.23, alpha: 0.075 },
] as const;

/**
 * How far up each side the light reaches, as a share of the LAYER — which is
 * now the whole content column rather than a 38vh band at its foot.
 *
 * 0.78. In the band era this was 0.88 of a 38vh strip, i.e. about a third of
 * the window; the first full-column pass cut it to 0.52 on the argument that
 * light above the midline encloses the reader. That argument was answering a
 * bug: with the arms clipped at their tips (see `paintRim`), every extra
 * centimetre of arm moved a SEAM further up the window, so of course less of
 * it looked better. Unclipped, an arm ends in a taper instead of a line, and
 * the light can go where the eye expects a lit room to be lit — up the sides,
 * dying out before the top.
 */
const ARM_OF_BAND = 0.78;

/**
 * Share of an edge over which the ribbon fades out at its FREE end — the top of
 * an arm, and nothing on the bottom, which has no free end. Long, because a
 * short taper leaves a visible stub — and longer now that the arm itself is,
 * so the fade stays a fade rather than becoming a top half that is simply on.
 */
const ARM_FADE = 0.78;

/**
 * Cap on an arm pool's radius, as a share of the arm's own length.
 *
 * The bottom's reach is a share of the WIDTH, which on any landscape window is
 * the larger dimension — so an arm sized off it carries pools wider than the
 * ribbon they sit on. That is what made the clip visible in the first place,
 * and removing the clip without this would simply have turned the seam into a
 * flood.
 */
const ARM_REACH_OF_LENGTH = 0.66;

/** How deep into the column the bottom rim carries, as a share of its width. */
const RIM_REACH = 0.42;

/** Share of the bottom edge over which the ribbon eases in at each corner. */
const CORNER_EASE = 0.05;

/**
 * A call is a mode you deliberately entered, and the light is the main thing
 * telling you it is live, so it paints at full strength.
 *
 * There used to be a second rung at 62% for everything that was not a call —
 * a streaming reply, a research run — on the argument that the light must
 * never compete with the text it announces. That argument won completely:
 * those sources no longer paint at all (see the header of `lib/aura.ts`), so
 * there is one presence and it is this one.
 */
const PRESENCE_VOICE = 1;

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

  // NO PORTAL. The layer used to be `position: fixed` in a body portal so it
  // could paint the whole window frame; it is `position: absolute` now and
  // positions against `<main>`, which is exactly the content column and
  // exactly what a call is a mode of. An ancestor transform becoming its
  // containing block is no longer a hazard but the mechanism.
  React.useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
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
    type Hsl = [number, number, number];
    // Seeded with the light theme's values so a failed read looks like the
    // default rather than like nothing.
    const palette: Record<AuraInk, Hsl> = {
      you: [15, 54, 46],
      thinking: [258, 90, 66],
      juno: [187, 62, 34],
      alarm: [11, 51, 48],
      quiet: [48, 4, 40],
    };
    const readColours = () => {
      const root = document.documentElement;
      palette.you = readHSL(root, "--aura-you") ?? palette.you;
      palette.thinking = readHSL(root, "--aura-thinking") ?? palette.thinking;
      palette.juno = readHSL(root, "--aura-juno") ?? palette.juno;
      palette.alarm = readHSL(root, "--destructive") ?? palette.alarm;
      palette.quiet = readHSL(root, "--muted-foreground") ?? palette.quiet;
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
    // The live ink, eased toward the state's own. Seeded from the state at
    // mount: mounting mid-answer is not a turn boundary, and starting from
    // somebody else's ink would wash Juno's voice in the wrong colour and then
    // correct itself in front of you.
    let hue = palette[INK[previous]][0];
    let sat = palette[INK[previous]][1];
    let lum = palette[INK[previous]][2];
    let tempo = TEMPO[previous];
    const presence = PRESENCE_VOICE;

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
      // Held, not eased toward idle's ink: the light is fading out, and
      // sweeping its colour on the way would recolour a state the user is
      // still watching disappear.
      if (state !== "idle") {
        const [th, ts, tl] = palette[INK[state]];
        // A failure lands fast; everything else sweeps. Hue on the SHORT arc,
        // or teal → violet would travel the long way round through red.
        const rate = ease(state === "error" ? 5 : state === "done" ? 4 : 2.6);
        hue = mixHue(hue, th, rate);
        sat = mix(sat, ts, rate);
        lum = mix(lum, tl, rate);
        const tempoTarget = state === "answering" ? ANSWERING_TEMPO[now.drive] : TEMPO[state];
        tempo += (tempoTarget - tempo) * ease(2.2);
      }

      // Reduced motion freezes the travel and keeps the envelope: the waves
      // stop moving but keep their shape, so the layer is a still coloured
      // envelope whose height and hue change per state. It never becomes a flat
      // line, because it is information.
      if (!reduced) clock += dt * tempo;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (width === 0 || height === 0 || smooth <= 0.001) return;

      const paintTone = (a: number) => `hsl(${hue} ${sat}% ${lum}% / ${a * presence})`;

      /*
       * THE FIELD. Lobes sunk outside the layer, so only their inner falloff
       * is on screen and the light appears to come from beyond the column
       * rather than from a circle sitting on it.
       *
       * `span` is the width now, not `min(width, height * 2.4)`. That
       * expression existed to reconstruct the window height a bottom BAND was
       * no longer measuring; the layer is the whole column again, so the
       * reconstruction is not only unnecessary but wrong — on a tall window it
       * made the light smaller than the space it had.
       */
      const span = width;
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
        // ITS OWN BOUNDING BOX, not the whole canvas. A radial gradient is
        // transparent past its last stop, so filling the full layer painted
        // millions of pixels that could not change — affordable on a 38vh
        // band, not on a full column. Five lobes over the whole canvas was
        // the single reason the band existed.
        ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      }

      // How deep into the column the rim carries, as a share of its width.
      // 0.42, up from a third — the light is meant to be the room the
      // conversation is in, and a third of the width on a laptop is a strip
      // along the bottom bezel.
      const reach = span * RIM_REACH * smooth;
      if (reach >= 1) paintRim(reach, paintTone);
      fadeTop();
    };

    /**
     * The pools of light along each of the three edges.
     *
     * Drawn in the edge's own local frame (x along the edge, y away from it),
     * so the maths is written once for one direction and the canvas transform
     * does the rotating — the same reason the edges exist at all.
     *
     * EACH POOL IS FILLED OVER ITS OWN BOUNDING BOX, and the fact that this
     * had to be said twice is the whole history of this layer. The first
     * version filled `(0, 0, edge.length, r)` — the EDGE's box, not the
     * POOL's — which is a clip, and a clip through a gradient carrying alpha
     * is a hard line. On the arms it was unmistakable: an arm is ~0.5 of the
     * window's height while a pool's radius is sized off its WIDTH, so the
     * widest pools were nearly twice the length of the ribbon they sat on and
     * got sheared off flat at the arm's tip. Both arms shear at the same
     * height, so what rendered was a seam straight across the window at
     * mid-screen — the same failure as the stacked-gradient version above,
     * wearing a different shape.
     *
     * Filling the pool's own square instead means the gradient reaches its
     * transparent last stop on its own in every direction, exactly as the
     * lobes do. Nothing is clipped, so nothing can show a cut, and the arm's
     * free end is shaped by `windowAt` fading its pools' ALPHA rather than by
     * cutting their geometry.
     */
    const paintRim = (base: number, paintTone: (a: number) => string) => {
      for (const edge of edges()) {
        if (edge.length < 1) continue;
        const [a, b, c, d, e, f] = edge.m;
        ctx.setTransform(a * dpr, b * dpr, c * dpr, d * dpr, e * dpr, f * dpr);

        // An arm is a share of the HEIGHT and the reach is a share of the
        // WIDTH, so on any landscape window an arm pool sized off the bottom's
        // reach is larger than the arm itself — it stops reading as a rim and
        // becomes a wash up the side. Capped against the arm's own length, the
        // light along a side is proportionate to the side.
        const reach = edge.arm ? Math.min(base, edge.length * ARM_REACH_OF_LENGTH) : base;

        for (const pool of POOLS) {
          const r = Math.max(1, reach * pool.spread);
          const drift = reduced ? 0 : Math.sin(clock * pool.speed + pool.phase) * edge.length * pool.swing;
          const cx = edge.length * pool.at + drift;
          const cy = -r * pool.sink;
          const breath = reduced
            ? 1
            : 1 + POOL_BREATH * Math.sin(clock * POOL_BREATH_SPEED + pool.phase * 1.31);
          const alpha = pool.alpha * breath * windowAt(pool.at, edge.arm);
          if (alpha <= 0.002) continue;

          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
          g.addColorStop(0, paintTone(alpha));
          // Two mid stops rather than one: a single linear ramp inside a
          // radial gradient reads as a disc with a soft edge, and three make
          // it read as a falloff. The strongest light still hugs the surface
          // edge, so the composer sitting inside the reach is lit rather than
          // washed.
          g.addColorStop(0.38, paintTone(alpha * 0.42));
          g.addColorStop(0.72, paintTone(alpha * 0.12));
          g.addColorStop(1, paintTone(0));
          ctx.fillStyle = g;
          ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
        }
      }
    };

    /** See TOP_FADE: the band has to end somewhere, and not on a hard line. */
    const fadeTop = () => {
      const fade = height * TOP_FADE;
      if (fade < 1) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cut = ctx.createLinearGradient(0, 0, 0, fade);
      // Sampled along a smoothstep rather than left as a two-stop ramp. A
      // linear erase is continuous in VALUE but not in slope, and the eye
      // reads a slope discontinuity over a near-uniform wash as an edge —
      // a Mach band exactly where the mask stops, which is the artefact this
      // whole function exists to remove. Five stops is enough for the kink to
      // fall below a level step; the curve is flat at both ends by
      // construction, so there is nothing left to see.
      for (let i = 0; i <= 4; i += 1) {
        const t = i / 4;
        cut.addColorStop(t, `rgba(0,0,0,${(1 - smoothstep(t)).toFixed(4)})`);
      }
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
  }, []);

  // No role, no focusable content, `aria-hidden`: every state it shows is
  // already announced elsewhere — PHASE_ANNOUNCEMENT says the call's phase in
  // words — so it adds nothing to the accessibility tree by design.
  // `pointer-events: none` lives in the class; it can never take a click.
  return (
    <div ref={wrapRef} className="ambient-aura" aria-hidden="true">
      <canvas ref={canvasRef} className="ambient-aura__canvas" />
    </div>
  );
}

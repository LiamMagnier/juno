"use client";

import * as React from "react";
import { useClock, useTick } from "./clock";

/*
 * ⚠ STAND-IN: the Continuum mark and the ThinkingMark, until the production
 * components land in src/components/brand/ (another workflow is building the
 * reviewed segmented vector geometry, the wordmark and ThinkingMark there).
 * These four paths are traced from the raster reference
 * (docs/rework/brand/assets/alevr-continuum-symbol.png: flattened, Moore
 * boundary trace at 1536 px, light smoothing, RDP at 0.8 px) so the voice
 * design can be judged with the real silhouette; they are not the reviewed
 * master and must not be copied into production. Replace every use of
 * <ContinuumStandIn> and <ThinkingMarkStandIn> with the brand components once
 * they are on the trunk; the pass schedule below is the part to keep in sync.
 *
 * The mark: the blades around an open aperture, uniform graphite on light,
 * pale neutral on dark (currentColor). Square 100-unit box, the mark centred
 * (it is wider than tall: a 20 px mark is 20 px wide, about 14 px tall).
 */

export const CONTINUUM_BLADES: readonly string[] = [
  /* top */ "M57.5 15.8L59.6 16.0L61.7 16.4L63.3 17.2L64.9 18.5L66.0 20.1L66.6 21.2L67.0 22.6L67.5 25.1L67.5 27.4L67.2 29.4L66.6 32.2L65.6 35.2L64.8 37.4L63.4 40.2L61.4 43.6L59.2 46.8L57.1 49.4L57.0 49.4L56.9 49.3L56.8 46.8L56.5 45.5L55.9 43.3L54.6 40.8L53.8 39.6L52.9 38.6L51.3 37.4L50.1 36.7L48.7 36.1L45.8 35.3L43.9 35.1L42.1 35.0L37.6 35.4L33.4 36.2L28.5 37.5L25.7 38.4L23.4 39.3L18.1 41.5L12.3 44.4L8.8 46.2L6.0 47.9L0.0 51.6L1.4 49.9L4.2 47.0L9.1 42.4L13.1 39.0L16.9 35.9L23.8 30.7L27.3 28.3L31.4 25.8L34.5 23.9L37.5 22.3L41.7 20.3L45.3 18.7L47.5 17.9L49.9 17.1L52.9 16.4L55.4 16.0Z",
  /* right */ "M71.4 26.6L71.7 26.8L73.8 28.7L76.6 31.7L81.0 36.6L82.8 38.9L85.5 42.6L88.0 46.7L88.8 48.2L89.7 50.2L90.2 52.0L90.4 53.3L90.3 55.0L90.0 56.0L89.7 57.0L88.9 58.5L87.9 59.7L86.7 60.8L84.5 62.1L82.2 63.0L80.1 63.7L77.1 64.4L71.9 65.2L69.1 65.4L64.9 65.5L61.4 65.3L58.9 65.1L56.0 64.7L52.3 64.0L49.6 63.4L47.3 62.5L47.2 62.4L47.4 62.2L50.2 60.2L53.1 57.9L57.1 54.4L59.6 51.8L62.2 49.0L65.1 45.2L66.7 42.7L67.8 40.8L69.6 36.8L70.5 34.1L71.0 31.7L71.3 28.9Z",
  /* left */ "M38.1 41.7L40.7 41.7L40.9 41.8L40.8 41.9L37.4 45.2L35.1 47.6L33.1 50.0L31.1 52.5L28.8 55.9L27.2 58.5L26.1 60.9L25.0 63.7L24.3 66.3L23.9 68.1L23.8 69.5L23.8 71.8L24.1 74.4L24.5 75.7L25.2 77.6L23.6 77.2L20.1 75.8L16.8 74.1L14.4 72.6L12.7 71.3L10.3 69.2L8.8 67.6L7.3 65.9L5.9 63.6L5.0 61.7L4.4 59.2L4.3 57.5L4.4 56.5L4.8 55.2L5.5 53.8L6.8 52.2L8.6 50.8L11.8 48.8L15.5 47.0L17.2 46.3L20.7 45.0L25.4 43.6L29.6 42.7L34.1 42.0Z",
  /* bottom */ "M31.8 57.5L32.0 59.4L32.3 60.5L32.8 62.1L33.4 63.1L34.1 64.3L35.3 65.7L36.0 66.3L37.6 67.4L38.8 68.1L41.3 69.2L43.7 70.0L47.7 70.7L50.5 71.0L54.4 71.3L60.4 71.3L69.4 70.8L77.9 70.0L83.0 69.3L90.5 68.1L100.0 66.2L96.6 68.1L91.9 70.5L87.9 72.3L83.8 74.2L76.0 77.2L70.7 79.1L67.3 80.1L62.9 81.3L59.0 82.3L54.1 83.2L51.1 83.7L48.2 84.0L45.7 84.2L43.3 84.2L40.6 83.9L37.3 83.2L36.1 82.8L34.5 82.0L32.9 80.9L31.6 79.7L30.4 78.2L29.5 76.5L28.9 74.9L28.4 72.5L28.2 70.5L28.4 67.8L28.6 66.3L29.3 63.6L30.1 61.1L31.1 58.9Z",];

/**
 * The order the tone passes in: clockwise around the aperture, the way the
 * blades' broad heads lead and their pointed paths trail (top, right, bottom, left).
 */
const PASS_ORDER = [0, 1, 3, 2];

/* ———————————————————— The pass: one schedule for every thinking surface ———————————————————— */

/**
 * MOTION_AND_THINKING: 220 ms tone transition, 70 ms stagger between adjacent
 * paths, one pass when thinking starts, a re-pass for new real activity
 * coalesced to at most one every 1.6 s, a quiet stable pose otherwise.
 */
export const PASS = { tone: 220, stagger: 70, coalesce: 1600 } as const;

/**
 * When passes start, from the times real thinking events arrived (the start
 * itself, each new step or reasoning batch). An event inside the 1.6 s window
 * schedules one pass at the window's end; further events before that pass are
 * absorbed by it. Pure, so a frozen still is reproducible.
 */
export function passStarts(beats: readonly number[]): number[] {
  const out: number[] = [];
  let last = -Infinity;
  for (const b of [...beats].sort((x, y) => x - y)) {
    if (b <= last) continue;
    if (b - last >= PASS.coalesce) last = b;
    else last += PASS.coalesce;
    out.push(last);
  }
  return out;
}

const smooth = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};

/** One segment's tint (0 rest, 1 presence) `tau` ms after the pass reached it: up over 220, back over 220. */
export function passTint(tau: number): number {
  if (tau < 0 || tau >= PASS.tone * 2) return 0;
  return tau < PASS.tone ? smooth(tau / PASS.tone) : 1 - smooth((tau - PASS.tone) / PASS.tone);
}

/** The tint of segment `i` at scene time `t`, given the pass starts (the most recent pass that has reached it). */
export function segmentTint(i: number, t: number, starts: readonly number[]): number {
  let k = 0;
  for (const s of starts) k = Math.max(k, passTint(t - s - i * PASS.stagger));
  return k;
}

/* ———————————————————— The mark ———————————————————— */

export function ContinuumStandIn({ size = 20, className, title }: { size?: number; className?: string; title?: string }) {
  return (
    <svg
      className={["jv-continuum", className].filter(Boolean).join(" ")}
      viewBox="0 0 100 100"
      width={size}
      height={size}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      data-standin=""
    >
      {CONTINUUM_BLADES.map((d, i) => (
        <path key={i} d={d} fill="currentColor" />
      ))}
    </svg>
  );
}

/**
 * The ThinkingMark (stand-in): the stationary mark beside truthful phase
 * words; on each scheduled pass one blade shifts toward the presence ink and
 * hands it to the next. Nothing rotates, scales or glows; with no new events
 * it holds the quiet graphite pose. Reduced motion: the static mark.
 * Decorative: the words beside it carry the meaning.
 */
export function ThinkingMarkStandIn({ size = 16, beats, className }: { size?: number; beats: readonly number[]; className?: string }) {
  const clock = useClock();
  const refs = React.useRef<(SVGPathElement | null)[]>([]);
  const starts = React.useMemo(() => passStarts(beats), [beats]);
  useTick(
    (t) => {
      PASS_ORDER.forEach((blade, i) => {
        const el = refs.current[blade];
        if (!el) return;
        const k = clock.reduced ? 0 : segmentTint(i, t, starts);
        el.style.fill = k <= 0.001 ? "currentColor" : `color-mix(in oklab, currentColor ${Math.round((1 - k) * 100)}%, var(--presence))`;
      });
    },
    [starts, clock.reduced],
  );
  return (
    <svg className={["jv-continuum jv-thinkmark", className].filter(Boolean).join(" ")} viewBox="0 0 100 100" width={size} height={size} aria-hidden="true" focusable="false" data-standin="">
      {CONTINUUM_BLADES.map((d, i) => (
        <path
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          d={d}
          fill="currentColor"
        />
      ))}
    </svg>
  );
}

"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import type { ReasoningOption } from "@/lib/model-metrics";

/**
 * Thinking-effort slider — one discrete stop per tier the model actually
 * supports (Instant · Minimal · Low · Medium · High · Extra high · Max), so the
 * stop count follows the model: GPT-5.6 gets six, Claude Opus 4.5 gets four, an
 * on/off model gets two.
 *
 * The visible track is decorative; a real <input type="range"> sits on top at
 * zero opacity, which buys native keyboard support (arrows/Home/End), drag, and
 * screen-reader semantics for free. aria-valuetext carries the tier NAME so
 * assistive tech announces "High", not "4".
 *
 * The final stop gets a distinct treatment — panning gradient plus a star field —
 * because it is the one tier that is materially slower and pricier, and should
 * feel like a deliberate escalation rather than one more notch. All of it sits
 * behind `motion-safe:`.
 */

/* ── Geometry ──────────────────────────────────────────────────────────────
 * TRACK 36 = PAD 4 + LANE 28 + PAD 4. The fill is inset by PAD on ALL four
 * sides, so it lives in the same 28px lane the thumb travels along, and the
 * thumb (also 28px) covers the fill's right cap exactly.
 *
 * That inset is what removes the halo: the fill used to be full track height
 * and wider than the thumb, so at the first stop its cap bled out around the
 * thumb as a coral ring. Now at frac 0 the fill is exactly THUMB wide and sits
 * exactly under the thumb — invisible. At frac 1 it fills the whole lane.
 *
 * Radii are concentric by construction: track r=18 (36/2), fill/thumb r=14
 * (28/2), and 18 − 4 (PAD) = 14.
 */
const PAD = "0.25rem"; // 4px
const THUMB = "1.75rem"; // 28px — same as the lane height
/** Distance the thumb's left edge can travel, measured against the TRACK's width. */
const TRAVEL = `(100% - ${PAD} * 2 - ${THUMB})`;
/** Centre of stop `frac` — dots share the thumb's travel, so one always sits under it. */
const centerAt = (frac: number) => `calc(${PAD} + ${THUMB} / 2 + ${TRAVEL} * ${frac})`;

/* ── Motion ────────────────────────────────────────────────────────────────
 * The thumb and the fill's right cap are welded together: the cap lives exactly
 * under the thumb, so any disagreement between them shows up instantly as a
 * coral crescent. Keeping them in lockstep drives the whole rig below.
 *
 * Both ride a "carrier" element sized to the LANE and animate `transform`, never
 * `left`/`width`. Two reasons, in order of importance:
 *   1. transform is compositor-only — no reflow per frame, and it interpolates
 *      off the main thread.
 *   2. it is the only way the two stay locked. `width` is a layout property and
 *      `transform` is not; run one of each and the browser resolves them on
 *      different clocks, so the fill's cap visibly lags the thumb mid-flight.
 *      Same property + same duration + same curve + same distance = same frame.
 *
 * The "same distance" half of that is why both carriers are LANE-sized: `100%`
 * inside a translate resolves against the element's OWN width, so one expression
 * is literally the same number of pixels for both. LANE − THUMB is the identical
 * quantity as the track-relative TRAVEL above (track − 2·PAD − THUMB).
 *
 * The transform ladder, outermost first. Each rung owns exactly one transform,
 * because a single element has a single `transform` and a single transition for
 * it — rungs are how motions get independent curves.
 *   carrier  translateX(travel)   detent → detent
 *   flight   translateX(±RECOIL)  the spring past the detent
 *   popper   translateY(-50%)     static centring / the ultra-pop flourish
 *   thumb    scale(…)             squash + grip
 */

/** Travel to `frac`, expressed against a LANE-sized element. */
const travelX = (frac: number) => `translateX(calc((100% - ${THUMB}) * ${frac}))`;

/** Shared verbatim by the thumb carrier and the fill carrier — the lockstep
 *  guarantee is that neither can drift from the other without editing this. */
const TRAVEL_MOTION =
  "motion-safe:transition-[transform] motion-safe:duration-base motion-safe:ease-spring";

/** The recoil layer: leads the travel by RECOIL while a move is in flight, then
 *  releases. Faster in than the travel, so the thumb is running ahead of its own
 *  carrier and lands past the detent before easing back into it. */
const FLIGHT_MOTION =
  "motion-safe:transition-[transform] motion-safe:duration-fast motion-safe:ease-out-expo";

/**
 * Overshoot past the detent — a FIXED distance, not a percentage of the step,
 * and not an overshooting cubic-bezier (a y > 1 control point would have been
 * the one-liner here).
 *
 * A bezier's overshoot scales with the distance travelled, and this slider's step
 * size is set by the model: on a seven-stop track a ~4% overshoot is a tidy ~1.5px
 * detent, but a two-stop Instant/Thinking model makes one step the ENTIRE 204px
 * travel, and the same curve throws the thumb ~8px clean off the end of the rail.
 * There is no percentage that is both visible at seven stops and safe at two.
 *
 * A fixed lead has no such coupling, and the geometry bounds it: the thumb springs
 * into the track's own padding and can never leave the rail. The budget is exact and
 * nearly spent — recoil + the squash's half-growth must stay under PAD:
 *     3px + 28px × (1.06 − 1) / 2  =  3.84px  ≤  PAD 4px
 * so raising either RECOIL or the squash below pushes the thumb off the track at the
 * last stop. It also self-regulates: a long step's travel curve has not yet converged
 * when the recoil releases, so it absorbs the lead instead of overshooting — exactly
 * the case (two stops, one 200px step) where an overshoot would have looked broken.
 *
 * Direction is not cosmetic. The fill runs off the left of the clip, so it is only
 * hidden at stop 0 because the thumb is parked over the lane's left cap; a RIGHTWARD
 * recoil there would slide the thumb off it and let a coral crescent out — the halo,
 * back. That state is unreachable rather than lucky: dir is sign(index − from), so
 * arriving at stop 0 means from > 0 means dir < 0, and the recoil can only ever push
 * the thumb deeper into the left pad. Keep that coupling if you touch either end.
 */
const RECOIL = (dir: number) =>
  dir > 0 ? "motion-safe:translate-x-[3px]" : dir < 0 ? "motion-safe:-translate-x-[3px]" : "";

/*
 * At the TOP stop the ultra-pop flourish plays on the `popper` rung — an ANCESTOR
 * of the thumb's squash — and nested transforms MULTIPLY: 1.18 × 1.06 = 1.2508.
 * On the real 264px popover (track 240) the last stop centres the thumb at 222, so
 * a +3px recoil plus a half-width of 14 × 1.2508 = 17.51 puts its right edge at
 * 242.51 against a 240px track: a 2.51px overhang, at the one stop the flourish
 * exists to celebrate. (The earlier "0.16px clearance" figure counted the squash
 * alone and missed the ancestor entirely.)
 *
 * So the top stop yields: ultra-pop IS the landing there, and stacking a recoil and
 * a squash on top of it is both redundant and what pushes the thumb off the rail.
 * Dropping both restores 14 × 1.18 = 16.52 -> right edge 238.52, i.e. 1.48px inside
 * the track — exactly the clearance this control had before the motion work.
 * See `topOwnsLanding` at the call site.
 */

/** Just under the travel's duration-base (220ms): the recoil releases as the
 *  carrier converges, so the release *is* the landing rather than a second move. */
const FLIGHT_MS = 210;

/** Violet accent reserved for the top tier (Juno's own primary is coral).
 *  Driven by the --ultra token, never a hardcoded hex: the app swaps accent
 *  colours at runtime, and a literal would silently opt out of that. */
const ULTRA = "hsl(var(--ultra))";

/** Fixed scatter — deterministic so SSR and client agree (no Math.random). */
const SPARKS: { left: number; top: number; size: number; delay: number; duration: number }[] = [
  { left: 9, top: 32, size: 2, delay: 0, duration: 2.6 },
  { left: 18, top: 64, size: 1.5, delay: 0.7, duration: 3.1 },
  { left: 27, top: 26, size: 2.5, delay: 1.4, duration: 2.3 },
  { left: 35, top: 58, size: 1.5, delay: 0.35, duration: 3.4 },
  { left: 44, top: 34, size: 2, delay: 1.9, duration: 2.8 },
  { left: 53, top: 68, size: 1.5, delay: 0.9, duration: 3.7 },
  { left: 60, top: 40, size: 2.5, delay: 2.2, duration: 2.5 },
  { left: 69, top: 62, size: 1.5, delay: 1.15, duration: 3.2 },
  { left: 76, top: 30, size: 2, delay: 0.5, duration: 2.9 },
  { left: 84, top: 56, size: 1.5, delay: 1.7, duration: 3.5 },
  { left: 91, top: 38, size: 2, delay: 2.4, duration: 2.7 },
];

export function ReasoningSlider({
  options,
  value,
  onChange,
  disabled,
  className,
}: {
  options: ReasoningOption[];
  value: ReasoningOption["value"];
  onChange: (v: ReasoningOption["value"]) => void;
  disabled?: boolean;
  className?: string;
}) {
  const count = options.length;
  // findIndex is exact: Instant's value is null, and null === null, so an
  // Instant selection resolves to stop 0 rather than falling back to it.
  const found = options.findIndex((o) => o.value === value);
  const index = found < 0 ? 0 : found;
  const last = count - 1;
  const isTop = count > 1 && index === last;
  const frac = last > 0 ? index / last : 0;

  // Re-fire the thumb's landing flourish on each fresh arrival at the top tier.
  const [popKey, setPopKey] = React.useState(0);
  const wasTop = React.useRef(isTop);
  React.useEffect(() => {
    if (isTop && !wasTop.current) setPopKey((k) => k + 1);
    wasTop.current = isTop;
  }, [isTop]);

  // Sign of the move currently in flight (0 = settled). Drives both the recoil
  // and the squash, which are the same event seen from two elements.
  const [flight, setFlight] = React.useState(0);
  const prevIndex = React.useRef(index);
  React.useEffect(() => {
    const from = prevIndex.current;
    prevIndex.current = index;
    if (from === index) return; // also covers first render, so mount never animates
    setFlight(Math.sign(index - from));
    // Re-running (arrow key held down) restarts the timer, so a run of steps stays
    // in one continuous flight and only settles once the user stops — which is what
    // a real object dragged across detents does.
    const t = window.setTimeout(() => setFlight(0), FLIGHT_MS);
    return () => window.clearTimeout(t);
  }, [index]);

  // "Held" while the pointer is down on the range. The native range keeps tracking
  // a drag well outside its own box, so the release has to be caught on the window
  // or the thumb stays gripped forever.
  const [held, setHeld] = React.useState(false);
  const releaseRef = React.useRef<AbortController | null>(null);
  const grab = React.useCallback(() => {
    releaseRef.current?.abort();
    const ac = new AbortController();
    releaseRef.current = ac;
    setHeld(true);
    const release = () => {
      setHeld(false);
      ac.abort();
    };
    window.addEventListener("pointerup", release, { signal: ac.signal });
    window.addEventListener("pointercancel", release, { signal: ac.signal });
  }, []);
  React.useEffect(() => () => releaseRef.current?.abort(), []);

  if (count < 2) return null;
  const current = options[index];
  // At the top stop ultra-pop plays on an ancestor rung and its scale MULTIPLIES
  // with the thumb's squash, so recoil + squash there overhang the track by
  // 2.51px. Let the flourish own the landing instead — see RECOIL above.
  const topOwnsLanding = isTop;
  const recoil = topOwnsLanding ? "" : RECOIL(flight);

  return (
    <div className={cn("select-none", className)}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Thinking</span>
        <span
          className="font-mono text-[11px] font-medium tracking-tight transition-colors duration-base ease-out-soft"
          style={isTop ? { color: ULTRA } : undefined}
          aria-hidden="true"
        >
          {current.label}
        </span>
      </div>

      <div
        className={cn(
          "relative h-9 w-full rounded-full bg-muted/70 transition-opacity duration-base ease-out-soft",
          disabled && "pointer-events-none opacity-50"
        )}
      >
        {/* The lane window. Clips the fill to the exact 28px lane and lends it its
            left cap (r14, concentric with the track's r18 across PAD 4). The thumb
            is deliberately NOT in here — this is the one overflow-hidden in the
            control, and it would slice shadow-pop into a hard bar. */}
        <div className="pointer-events-none absolute inset-1 overflow-hidden rounded-full">
          {/* Carrier: lane-sized, so `100%` below is the lane. */}
          <div className={cn("absolute inset-0", TRAVEL_MOTION)} style={{ transform: travelX(frac) }}>
            {/* The fill is a pill THUMB-wide at its right end and long enough to run
                off the left of the clip at every frac, so growth is pure translation
                rather than an animated width. Its right cap keeps a true r14 — it is
                never scaled — and rides under the thumb exactly as before. The fill
                doubles as the recoil rung; its transform is otherwise unused. */}
            <div
              className={cn(
                "absolute inset-y-0 rounded-full",
                FLIGHT_MOTION,
                recoil,
                isTop
                  ? "bg-[linear-gradient(90deg,hsl(var(--primary)),hsl(var(--ultra-from)),hsl(var(--ultra-to)),hsl(var(--ultra-from)),hsl(var(--primary)))] bg-[length:200%_100%] motion-safe:animate-ultra-pan"
                  : "bg-primary"
              )}
              style={{ left: "-100%", width: `calc(100% + ${THUMB})` }}
            />
          </div>

          {/* Star field — only meaningful once the gradient is showing, and by then
              the fill is the whole lane, so these scatter across the clip itself. */}
          {isTop &&
            SPARKS.map((s, i) => (
              <span
                key={i}
                aria-hidden="true"
                className="absolute hidden rounded-full bg-white motion-safe:block"
                style={{
                  left: `${s.left}%`,
                  top: `${s.top}%`,
                  width: `${s.size}px`,
                  height: `${s.size}px`,
                  animation: `ultra-spark ${s.duration}s ease-in-out ${s.delay}s infinite`,
                }}
              />
            ))}
        </div>

        {/* Stop markers. The one under the thumb is hidden so it can't show
            through the white circle. */}
        {options.map((o, i) => (
          <span
            key={o.label}
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute top-1/2 size-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full transition-opacity duration-fast ease-out-soft",
              i === index ? "opacity-0" : i < index ? "bg-primary-foreground/45" : "bg-foreground/20"
            )}
            style={{ left: centerAt(last > 0 ? i / last : 0) }}
          />
        ))}

        {/* Thumb carrier — the fill carrier's twin: same box (the lane), same
            transform, same class constant. */}
        <div
          aria-hidden="true"
          className={cn("pointer-events-none absolute inset-y-1 left-1 right-1", TRAVEL_MOTION)}
          style={{ transform: travelX(frac) }}
        >
          <div className={cn("absolute inset-0", FLIGHT_MOTION, recoil)}>
            {/* The ultra-pop keyframe hardcodes translateY(-50%), so the element it
                animates has to be the one that owes a -50% — hence top-1/2 here
                rather than pinning the thumb to this lane-height box. */}
            <span
              key={popKey}
              className={cn("absolute left-0 top-1/2 size-7 -translate-y-1/2", isTop && "motion-safe:animate-ultra-pop")}
            >
              {/* Squash lives on a thumb-sized box, never on a carrier: scaling a
                  lane-sized box would drag its offset children sideways.
                  Every scale here is ≥ 1, and that is load-bearing. The fill's cap
                  is a r14 semicircle centred on the thumb, so a thumb any smaller
                  than 28px lets coral out around it — the exact halo the geometry
                  above exists to kill. So the move stretches along travel rather
                  than squashing across it, and the grip grows.
                  Held wins over in-flight: under a finger it reads as gripped, not
                  flying, and one class at a time keeps the two out of a transform
                  fight. The in-flight stretch also yields at the top stop, where
                  ultra-pop's 1.18 on the ancestor would multiply with it (1.2508)
                  and push the thumb past the rail — `held` is exempt because a
                  finger holding the thumb is not travelling, so the flourish is
                  not playing. */}
              <span
                className={cn(
                  "block size-full rounded-full bg-white shadow-pop ring-1 ring-black/[0.06]",
                  "motion-safe:transition-[transform] motion-safe:duration-fast motion-safe:ease-out-soft",
                  held
                    ? "motion-safe:scale-[1.06]"
                    : flight !== 0 && !topOwnsLanding
                      ? "motion-safe:scale-x-[1.06]"
                      : ""
                )}
              />
            </span>
          </div>
        </div>

        {/* The real control. Transparent, full-bleed, owns all interaction. */}
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={index}
          disabled={disabled}
          onPointerDown={grab}
          onChange={(e) => {
            // Index into options directly. Do NOT `?? value` the result: Instant's
            // value is null, and `null ?? value` would silently discard it and
            // make the first stop unselectable.
            const next = options[Number(e.target.value)];
            if (next) onChange(next.value);
          }}
          aria-label="Thinking effort"
          aria-valuetext={current.label}
          className="absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-full bg-transparent opacity-0 disabled:cursor-not-allowed"
        />
      </div>
    </div>
  );
}

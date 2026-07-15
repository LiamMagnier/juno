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
/** Distance the thumb's left edge can travel. */
const TRAVEL = `(100% - ${PAD} * 2 - ${THUMB})`;
/** Left edge of the thumb at `frac` (0..1). */
const thumbLeft = (frac: number) => `calc(${PAD} + ${TRAVEL} * ${frac})`;
/** Centre of stop `frac` — dots share the thumb's travel, so one always sits under it. */
const centerAt = (frac: number) => `calc(${PAD} + ${THUMB} / 2 + ${TRAVEL} * ${frac})`;
/** Fill grows from exactly-thumb-sized (hidden) to the full lane. */
const fillWidth = (frac: number) => `calc(${THUMB} + ${TRAVEL} * ${frac})`;

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

  if (count < 2) return null;
  const current = options[index];

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
        {/* Filled portion — inset into the thumb's lane on all four sides, so its
            right cap sits exactly under the thumb instead of haloing around it. */}
        <div
          className={cn(
            "pointer-events-none absolute inset-y-1 left-1 overflow-hidden rounded-full transition-[width] duration-base ease-spring",
            isTop
              ? "bg-[linear-gradient(90deg,hsl(var(--primary)),hsl(var(--ultra-from)),hsl(var(--ultra-to)),hsl(var(--ultra-from)),hsl(var(--primary)))] bg-[length:200%_100%] motion-safe:animate-ultra-pan"
              : "bg-primary"
          )}
          style={{ width: fillWidth(frac) }}
        >
          {/* Star field — only meaningful once the gradient is showing. */}
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

        {/* Thumb */}
        <span
          key={popKey}
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute top-1/2 size-7 -translate-y-1/2 rounded-full bg-white shadow-pop ring-1 ring-black/[0.06] transition-[left] duration-base ease-spring",
            isTop && "motion-safe:animate-ultra-pop"
          )}
          style={{ left: thumbLeft(frac) }}
        />

        {/* The real control. Transparent, full-bleed, owns all interaction. */}
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={index}
          disabled={disabled}
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

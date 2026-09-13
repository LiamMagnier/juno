"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import type { ReasoningOption } from "@/lib/model-metrics";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Thinking effort, as a slider.
 *
 * IT HAS BEEN FOUR THINGS, so the history is worth keeping.
 *
 * A range input with a neumorphic track and a shadowed thumb — the one
 * control that kept the Soft UI recipes after the flat retune
 * (docs/design/FLAT_UI.md §6). Then a row of six words, on the argument that a
 * discrete choice with six values is what a radio group is for. That is right
 * about semantics and wrong about the thing being chosen: effort is ORDERED.
 * Instant is less than Max and every rung between them is on the way, so a row
 * of equal words — which says "here are six options" — states something false
 * about the choice.
 *
 * Then a hairline rail with a 14px dot, which was a slider the way a volume
 * control buried in a settings pane is a slider: correct, and invisible. This
 * one is the object. A 28px pill, the accent filled up to where you are, a
 * knob big enough to look grabbable, the rungs marked inside the track, and
 * the rung you are on named above it in the accent.
 *
 * THE INTERACTION IS A NATIVE `input[type=range]`, invisible, stretched over
 * the painted pill. Drag, click-to-jump, arrows, Home/End, page keys and every
 * touch gesture come from the platform rather than from this file, and the
 * painted parts below are decoration that cannot fall out of sync with them.
 * `aria-valuetext` is what makes it say "High" rather than "3".
 *
 * The alignment between the invisible input and the painted knob is not a
 * coincidence and not a fudge: the browser insets a range thumb by half its
 * width at each end, so `.effort-range` in globals.css pins that thumb to
 * exactly THUMB px and the same inset is written into `atStop()` here. Change
 * one and you must change the other, which is why the number lives in one
 * place.
 *
 * THE TOP RUNG ANIMATES, and it is the one thing in this product's chrome
 * that does. Rule 10 of the premium audit says nothing in chrome moves except
 * a fill; this is a fill, and it is the case the exception exists for. Max is
 * not one more notch — it is the end of the scale, where a reply can take
 * minutes and cost several times the rung below it. A slow sheen travelling
 * the fill says "this is running at the top" with no badge, no colour change
 * and no warning copy. It stops dead under `prefers-reduced-motion`.
 *
 * The export keeps its old name so every composer that mounts it keeps
 * compiling; the props are unchanged.
 */

/**
 * Knob diameter, px. Must equal the width pinned in `.effort-range`.
 *
 * 28 — the full height of the track. The PAINTED knob is 24, sitting in the
 * track's 2px padding, but the inset a browser applies is half of the thumb
 * it was given, so the outer figure is what belongs here and in the CSS.
 */
const THUMB = 28;

/** Where stop `i` of `count` sits along the track, as a CSS length. */
const atStop = (i: number, count: number) => {
  const t = count > 1 ? i / (count - 1) : 0;
  return `calc(${(t * 100).toFixed(4)}% + ${(THUMB / 2 - t * THUMB).toFixed(3)}px)`;
};

export function ReasoningSlider({
  options,
  value,
  onChange,
  disabled,
  className,
  fastMode = false,
  onFastModeChange,
  proMode = false,
  onProModeChange,
}: {
  options: ReasoningOption[];
  value: ReasoningOption["value"];
  onChange: (value: ReasoningOption["value"]) => void;
  disabled?: boolean;
  className?: string;
  fastMode?: boolean;
  onFastModeChange?: (value: boolean) => void;
  proMode?: boolean;
  onProModeChange?: (value: boolean) => void;
}) {
  const count = options.length;
  const found = options.findIndex((option) => option.value === value);
  const index = found < 0 ? 0 : found;
  const current = options[index];

  if (count < 2) return null;

  const atMax = index === count - 1;
  const head = atStop(index, count);

  return (
    <div className={cn("select-none", className)}>
      {/* The eyebrow and the value on one line. The eyebrow used to be drawn
          by the model popover AROUND this control; it belongs here, beside
          the word it names, and every surface that mounts the slider gets it
          for free instead of only that one. */}
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="font-mono text-micro uppercase text-muted-foreground/60">Thinking</span>
        <span
          className={cn(
            "text-ui font-medium transition-colors duration-fast motion-reduce:transition-none",
            disabled ? "text-muted-foreground" : "text-primary",
          )}
        >
          {current?.label ?? ""}
        </span>
      </div>

      {/* h-9 for the hit area with the 28px pill centred in it: the pill is
          the size the design wants, and 28px alone is under every touch
          target minimum there is. */}
      <div className={cn("relative h-9 w-full coarse:h-11", disabled && "opacity-55")}>
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-7 -translate-y-1/2 overflow-hidden rounded-full bg-secondary">
          {/* The fill runs THROUGH the knob rather than up to it, so its
              rounded cap is hidden underneath instead of butting against a
              circle with a sliver of track showing between the two. */}
          <div
            className="absolute inset-y-0 left-0 overflow-hidden rounded-full bg-primary transition-[width] duration-slow ease-out-soft motion-reduce:transition-none"
            style={{ width: `calc(${head} + 12px)` }}
          >
            {/* THE SHEEN GETS ITS OWN ELEMENT, and that is not tidiness.
                Tailwind's `duration-slow` on the fill sets the duration for
                everything timed on that element, animation included, and it
                wins on layer order however the shorthand is written — so the
                2.8s travel was silently running at --dur-slow, 360ms, which
                is not a sheen but a strobe. A child with no timing utility on
                it cannot be overridden by one. */}
            {atMax && <span aria-hidden className="effort-sheen absolute inset-0" />}
          </div>

          {/* A mark per rung, inside the track. Behind the knob they sit on
              the accent and have to invert to stay visible. */}
          {options.map((option, i) => (
            <span
              key={`tick-${option.value}-${option.label}`}
              className={cn(
                "absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-fast motion-reduce:transition-none",
                i <= index ? "bg-primary-foreground/55" : "bg-muted-foreground/40",
              )}
              style={{ left: atStop(i, count) }}
            />
          ))}
        </div>

        {/* The knob, at the track's FULL height rather than inset inside it.
            Inset, its 24px disc sat on a 26px fill and left a 1px crescent of
            accent showing round the edge at the first rung — a coral ring on
            a control whose first rung means "no thinking at all". At the
            track's own height the fill's cap is covered in every position.
            A hairline, not a shadow: still the flat product. */}
        <div
          aria-hidden
          className="pointer-events-none absolute top-1/2 size-7 -translate-x-1/2 -translate-y-1/2 rounded-full border border-border/60 bg-knob transition-[left] duration-slow ease-out-soft motion-reduce:transition-none"
          style={{ left: head }}
        />

        <input
          type="range"
          min={0}
          max={count - 1}
          step={1}
          value={index}
          disabled={disabled}
          aria-label="Thinking effort"
          aria-valuetext={current?.label ?? String(index)}
          onChange={(event) => {
            const next = options[Number(event.target.value)];
            if (next) onChange(next.value);
          }}
          className="effort-range peer absolute inset-0 m-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0 focus-visible:outline-none disabled:cursor-not-allowed"
        />

        {/* Focus is drawn on the track, which has a box; the input it belongs
            to is transparent and has nothing to ring. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-1/2 h-7 -translate-y-1/2 rounded-full opacity-0 ring-2 ring-ring transition-opacity duration-fast peer-focus-visible:opacity-100 motion-reduce:transition-none"
        />
      </div>

      {(onFastModeChange || onProModeChange) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {onFastModeChange && (
            <ModeChip
              label="Flash"
              help="Prefer faster generation when the selected model supports it."
              pressed={fastMode}
              disabled={disabled}
              onPress={() => onFastModeChange(!fastMode)}
            />
          )}
          {onProModeChange && (
            <ModeChip
              label="Pro"
              help="Prefer the model's deeper reasoning mode when available."
              pressed={proMode}
              disabled={disabled}
              onPress={() => onProModeChange(!proMode)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ModeChip({
  label,
  help,
  pressed,
  disabled,
  onPress,
}: {
  label: string;
  help: string;
  pressed: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={pressed}
          onClick={onPress}
          className={cn(
            "inline-flex h-7 items-center rounded-control border px-2.5 text-caption font-medium transition-[background-color,color,border-color] duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring coarse:h-9 motion-reduce:transition-none",
            pressed
              ? "border-foreground bg-foreground text-background"
              : "border-border bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
            disabled && "cursor-not-allowed opacity-50",
          )}
        >
          {label}
        </button>
      </TooltipTrigger>
      <TooltipContent>{help}</TooltipContent>
    </Tooltip>
  );
}
